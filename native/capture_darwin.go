//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc -mmacosx-version-min=14.2
#cgo LDFLAGS: -framework CoreAudio -framework AVFoundation -framework AppKit -framework Foundation -mmacosx-version-min=14.2
#include <stdlib.h>
#include "tap_darwin.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"
)

// Core Audio calls goOnAudio on its real-time thread. It copies the samples
// onto a channel and one long-lived goroutine hands them to whichever sink is
// current, so switching sources never races the audio thread.
var (
	audioSink atomic.Pointer[AudioFunc]
	audioCh   = make(chan []float32, 64)
	audioOnce sync.Once
)

//export goOnAudio
func goOnAudio(data *C.float, frames C.int, rate C.int) {
	n := int(frames) * 2
	buf := make([]float32, n+1)
	copy(buf, unsafe.Slice((*float32)(unsafe.Pointer(data)), n))
	buf[n] = float32(rate) // rate rides along as the last value
	select {
	case audioCh <- buf:
	default: // never block the audio thread
	}
}

func startForwarding(onAudio AudioFunc) {
	audioSink.Store(&onAudio)
	audioOnce.Do(func() {
		go func() {
			for buf := range audioCh {
				if sink := audioSink.Load(); sink != nil {
					(*sink)(buf[:len(buf)-1], int(buf[len(buf)-1]))
				}
			}
		}()
	})
}

func cError(buf []byte) error {
	return errors.New(strings.TrimRight(string(buf), "\x00"))
}

// tapSource records some apps (or all of them) with a process tap.
type tapSource struct{ pids []int }

func (t *tapSource) Start(onAudio AudioFunc) error {
	startForwarding(onAudio)
	errBuf := make([]byte, 512)
	var p *C.int
	if len(t.pids) > 0 {
		cp := make([]C.int, len(t.pids))
		for i, pid := range t.pids {
			cp[i] = C.int(pid)
		}
		p = &cp[0]
	}
	if C.sd_tap_start(p, C.int(len(t.pids)), (*C.char)(unsafe.Pointer(&errBuf[0])), C.int(len(errBuf))) != 0 {
		return cError(errBuf)
	}
	return nil
}

func (t *tapSource) Stop() { C.sd_capture_stop(); audioSink.Store(nil) }

// inputSource reads an input device such as an audio interface.
type inputSource struct{ uid string }

func (s *inputSource) Start(onAudio AudioFunc) error {
	switch C.sd_mic_request() {
	case 1:
		return errors.New("macOS is blocking audio inputs for Silent Disco. Allow it under Privacy & Security → Microphone")
	}
	startForwarding(onAudio)
	uid := C.CString(s.uid)
	defer C.free(unsafe.Pointer(uid))
	errBuf := make([]byte, 512)
	if C.sd_input_start(uid, (*C.char)(unsafe.Pointer(&errBuf[0])), C.int(len(errBuf))) != 0 {
		return cError(errBuf)
	}
	return nil
}

func (s *inputSource) Stop() { C.sd_capture_stop(); audioSink.Store(nil) }

func openSource(s SourceInfo) (Source, error) {
	switch s.Kind {
	case KindSystem:
		return &tapSource{}, nil
	case KindApp:
		return &tapSource{pids: s.pids}, nil
	case KindInput:
		return &inputSource{uid: s.uid}, nil
	case KindTone:
		return &ToneSource{}, nil
	}
	return nil, fmt.Errorf("unknown source %q", s.ID)
}

func listProcesses() []audioProcess {
	cs := C.sd_list_processes()
	defer C.free(unsafe.Pointer(cs))
	var out []audioProcess
	for _, line := range strings.Split(C.GoString(cs), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 5 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		out = append(out, audioProcess{pid: pid, playing: f[1] == "1", appPath: f[2], name: f[3], bundle: f[4]})
	}
	return out
}

func listInputs() []SourceInfo {
	cs := C.sd_list_inputs()
	defer C.free(unsafe.Pointer(cs))
	var out []SourceInfo
	for _, line := range strings.Split(C.GoString(cs), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 3 || f[0] == "" {
			continue
		}
		detail := "Audio input"
		if f[2] == "1" {
			detail = "Audio input · mono"
		}
		out = append(out, SourceInfo{ID: "input:" + f[0], Kind: KindInput, Label: f[1], Detail: detail, uid: f[0]})
	}
	return out
}

// listSources is everything the DJ can pick right now.
func listSources() []SourceInfo {
	out := []SourceInfo{systemSource}
	out = append(out, groupApps(listProcesses())...)
	out = append(out, listInputs()...)
	return append(out, toneSource)
}

func appIcon(appPath string) ([]byte, bool) {
	if !strings.HasSuffix(appPath, ".app") {
		return nil, false
	}
	p := C.CString(appPath)
	defer C.free(unsafe.Pointer(p))
	var n C.int
	data := C.sd_app_icon_png(p, 64, &n)
	if data == nil {
		return nil, false
	}
	defer C.free(data)
	return C.GoBytes(data, n), true
}

// openPrivacySettings opens the System Settings pane that unblocks capture.
func openPrivacySettings(kind string) {
	pane := "Privacy_ScreenCapture" // "Screen & System Audio Recording"
	if kind == "mic" {
		pane = "Privacy_Microphone"
	}
	exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?"+pane).Start()
}
