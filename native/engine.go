package main

// The engine owns the party: which source is captured, whether we're on air,
// and the settings. The window, the menu bar and the terminal all drive it.

import (
	"math"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	StatusCapturing = "capturing"
	StatusWaiting   = "waiting" // the chosen app isn't open / input isn't plugged in
	StatusError     = "error"
)

type Engine struct {
	hub  *Hub
	bc   *Broadcaster
	enc  *Encoder
	scan func() []SourceInfo
	open func(SourceInfo) (Source, error)

	settingsFile string
	Port         int

	live      atomic.Bool
	level     atomic.Uint32 // float32 bits, latest peak
	lastAudio atomic.Int64  // when the source last delivered audio (unix nanos)

	mu       sync.Mutex
	settings Settings
	sources  []SourceInfo
	current  SourceInfo
	auto     bool // the source was picked for the DJ, so a DJ app may replace it
	src      Source
	pids     []int // processes the running tap covers
	status   string
	errMsg   string
	quiet    int // level ticks in a row with no sound
	silent   bool

	subsMu sync.Mutex
	subs   map[chan struct{}]struct{}
	// OnChange runs after any state change (on a goroutine of the engine's).
	OnChange func()
}

// State is what the DJ console shows.
type State struct {
	Name      string       `json:"name"`
	Kbps      int          `json:"kbps"`
	Live      bool         `json:"live"`
	Port      int          `json:"port"`
	Addresses []string     `json:"addresses"`
	Source    SourceInfo   `json:"source"`
	Status    string       `json:"status"`
	Error     string       `json:"error,omitempty"`
	Silent    bool         `json:"silent"`
	Auto      bool         `json:"auto"`
	Sources   []SourceInfo `json:"sources"`
}

func NewEngine(hub *Hub, bc *Broadcaster, enc *Encoder, settings Settings, settingsFile string) *Engine {
	e := &Engine{
		hub: hub, bc: bc, enc: enc,
		scan: listSources, open: openSource,
		settings: settings, settingsFile: settingsFile,
		subs: map[chan struct{}]struct{}{},
	}
	return e
}

// writeFrame is the encoder's output. Frames flow to phones all the time,
// silent while off air: a gap in the stream makes each phone's jitter buffer
// assume the network got worse and add delay it is slow to give back.
func (e *Engine) writeFrame(frame []byte) { e.bc.WriteFrame(frame) }

func (e *Engine) push(samples []float32, rate int) {
	e.lastAudio.Store(time.Now().UnixNano())
	e.enc.Push(samples, rate)
}

// fillLoop keeps the stream going with silence whenever no audio arrives:
// while the chosen app is closed, an input is unplugged, or the source is
// switching. Same reason as writeFrame.
func (e *Engine) fillLoop() {
	silence := make([]float32, frameSamples*channels)
	for range time.Tick(frameDuration) {
		if time.Since(time.Unix(0, e.lastAudio.Load())) > 100*time.Millisecond {
			e.enc.Push(silence, sampleRate)
		}
	}
}

// Start picks the first source and keeps watching for apps and devices
// coming and going. prefer is a source id from the command line, or "".
func (e *Engine) Start(prefer string, live bool) {
	e.live.Store(live)
	e.enc.SetMuted(!live)
	e.hub.SetMeta(Meta{Name: e.settings.Name, Live: live})
	e.mu.Lock()
	e.sources = e.scan()
	first, auto := e.pickInitial(prefer)
	e.auto = auto
	e.apply(first)
	e.mu.Unlock()
	e.changed()
	go e.levelLoop()
	go e.watchLoop()
	go e.fillLoop()
}

// pickInitial: the command line's choice, else the DJ's last pick if it's
// available, else open DJ software, else all system audio.
func (e *Engine) pickInitial(prefer string) (SourceInfo, bool) {
	if s, ok := findSource(e.sources, prefer); ok {
		return s, false
	}
	if s, ok := findSource(e.sources, e.settings.Source); ok {
		return s, false
	}
	if s, ok := bestDJApp(e.sources); ok {
		return s, true
	}
	if s, ok := findSource(e.sources, KindSystem); ok {
		return s, true
	}
	return e.sources[0], true
}

// apply switches capture to s. Caller holds e.mu.
func (e *Engine) apply(s SourceInfo) {
	if e.src != nil {
		e.src.Stop()
		e.src = nil
	}
	e.current = s
	e.pids = s.pids
	e.errMsg = ""
	e.quiet, e.silent = 0, false
	if (s.Kind == KindApp && len(s.pids) == 0) || (s.Kind == KindInput && s.uid == "") {
		e.status = StatusWaiting
		return
	}
	src, err := e.open(s)
	if err == nil {
		err = src.Start(e.push)
	}
	if err != nil {
		e.status, e.errMsg = StatusError, err.Error()
		return
	}
	e.src, e.status = src, StatusCapturing
}

// waitingFor stands in for a source that isn't available right now.
func waitingFor(id, label string) SourceInfo {
	kind := KindApp
	if strings.HasPrefix(id, "input:") {
		kind = KindInput
	}
	if label == "" {
		label = id[strings.IndexByte(id, ':')+1:]
	}
	return SourceInfo{ID: id, Kind: kind, Label: label}
}

// SetSource is the DJ picking a source.
func (e *Engine) SetSource(id string) bool {
	e.mu.Lock()
	s, ok := findSource(e.sources, id)
	if !ok {
		e.mu.Unlock()
		return false
	}
	e.auto = false
	e.apply(s)
	e.settings.Source, e.settings.SourceLabel = s.ID, s.Label
	saveSettings(e.settingsFile, e.settings)
	e.mu.Unlock()
	e.changed()
	return true
}

func (e *Engine) SetLive(live bool) {
	if e.live.Swap(live) == live {
		return
	}
	e.enc.SetMuted(!live)
	e.mu.Lock()
	name := e.settings.Name
	e.mu.Unlock()
	e.hub.SetMeta(Meta{Name: name, Live: live})
	e.changed()
}

func (e *Engine) Live() bool { return e.live.Load() }

func (e *Engine) SetName(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = defaultSettings.Name
	}
	if r := []rune(name); len(r) > 60 {
		name = string(r[:60])
	}
	e.mu.Lock()
	e.settings.Name = name
	saveSettings(e.settingsFile, e.settings)
	e.mu.Unlock()
	e.hub.SetMeta(Meta{Name: name, Live: e.live.Load()})
	e.changed()
}

func (e *Engine) SetKbps(kbps int) {
	kbps = clampKbps(kbps)
	e.mu.Lock()
	e.settings.Kbps = kbps
	saveSettings(e.settingsFile, e.settings)
	e.mu.Unlock()
	e.enc.SetBitrate(kbps)
	e.bc.SetKbps(kbps)
	e.changed()
}

func (e *Engine) State() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	return State{
		Name: e.settings.Name, Kbps: e.settings.Kbps, Live: e.live.Load(),
		Port: e.Port, Addresses: lanAddresses(),
		Source: e.current, Status: e.status, Error: e.errMsg, Silent: e.silent, Auto: e.auto,
		Sources: slices.Clone(e.sources),
	}
}

// Level is the latest audio peak, 0..1.
func (e *Engine) Level() float32 { return math.Float32frombits(e.level.Load()) }

// Stop releases the capture (macOS keeps nothing around after we exit, but
// stopping cleanly avoids a click on the DJ's output).
func (e *Engine) Stop() {
	e.mu.Lock()
	if e.src != nil {
		e.src.Stop()
		e.src = nil
	}
	e.mu.Unlock()
}

// Subscribe returns a channel that receives a value after state changes.
func (e *Engine) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	e.subsMu.Lock()
	e.subs[ch] = struct{}{}
	e.subsMu.Unlock()
	return ch, func() {
		e.subsMu.Lock()
		delete(e.subs, ch)
		e.subsMu.Unlock()
	}
}

func (e *Engine) changed() {
	e.subsMu.Lock()
	for ch := range e.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	e.subsMu.Unlock()
	if e.OnChange != nil {
		e.OnChange()
	}
}

func (e *Engine) levelLoop() {
	for range time.Tick(50 * time.Millisecond) {
		e.tickLevel(e.enc.Peak())
	}
}

// tickLevel records one level reading and notices long silence: a tap that
// macOS blocks delivers silence rather than an error.
func (e *Engine) tickLevel(peak float32) {
	e.level.Store(math.Float32bits(peak))
	e.mu.Lock()
	if e.status == StatusCapturing && peak < 0.0005 {
		e.quiet++
	} else {
		e.quiet = 0
	}
	silent := e.quiet >= 60 // 3 s
	flipped := silent != e.silent
	e.silent = silent
	e.mu.Unlock()
	if flipped {
		e.changed()
	}
}

func (e *Engine) watchLoop() {
	for range time.Tick(1500 * time.Millisecond) {
		e.rescan()
	}
}

// rescan refreshes the source list and follows apps and devices as they come
// and go: a DJ app that restarts is picked up again, an input plugged back
// in resumes, and DJ software that opens replaces an automatic choice of
// system audio.
func (e *Engine) rescan() {
	fresh := e.scan()
	e.mu.Lock()
	changed := !sameSources(fresh, e.sources)
	e.sources = fresh
	cur := e.current
	found, ok := findSource(fresh, cur.ID)
	switch {
	case e.auto && cur.Kind == KindSystem:
		if dj, ok := bestDJApp(fresh); ok {
			e.apply(dj)
			changed = true
		}
	case cur.Kind == KindApp && !slices.Equal(found.pids, e.pids):
		if !ok {
			found = waitingFor(cur.ID, cur.Label)
		}
		e.apply(found)
		changed = true
	case cur.Kind == KindInput && ok != (e.status != StatusWaiting):
		if !ok {
			found = waitingFor(cur.ID, cur.Label)
		}
		e.apply(found)
		changed = true
	}
	e.mu.Unlock()
	if changed {
		e.changed()
	}
}

func sameSources(a, b []SourceInfo) bool {
	return slices.EqualFunc(a, b, func(x, y SourceInfo) bool {
		return x.ID == y.ID && x.Label == y.Label && x.Detail == y.Detail &&
			x.DJ == y.DJ && x.Playing == y.Playing && slices.Equal(x.pids, y.pids)
	})
}
