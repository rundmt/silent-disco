//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc -mmacosx-version-min=14.2
#cgo LDFLAGS: -framework Cocoa -framework WebKit -mmacosx-version-min=14.2
#include <stdlib.h>
#include "app_darwin.h"
*/
import "C"

import (
	"runtime"
	"time"
	"unsafe"
)

// Cocoa must run on the main thread, which is the one main() starts on.
func init() { runtime.LockOSThread() }

const windowSupported = true

var windowEngine *Engine

// runWindow shows the DJ console and runs until the DJ quits.
func runWindow(e *Engine, url string) {
	windowEngine = e
	cs := C.CString(url)
	defer C.free(unsafe.Pointer(cs))
	C.sd_app_run(cs)
}

func setMenuStatus(text string, live bool) {
	cs := C.CString(text)
	defer C.free(unsafe.Pointer(cs))
	l := C.int(0)
	if live {
		l = 1
	}
	C.sd_app_set_status(cs, l)
}

//export goToggleLive
func goToggleLive() {
	go windowEngine.SetLive(!windowEngine.Live())
}

//export goWillQuit
func goWillQuit() {
	if windowEngine.Live() {
		windowEngine.SetLive(false) // phones show "off air" rather than hanging
		time.Sleep(200 * time.Millisecond)
	}
	windowEngine.Stop()
}
