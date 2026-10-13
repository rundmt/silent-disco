package main

// Model-based tests for the engine: rapid generates random sequences of what
// can happen at a party (apps opening, quitting and restarting, inputs coming
// and going, the DJ picking sources and going live) and checks the engine's
// rules after every step. Failures shrink to the shortest sequence that
// breaks a rule. This is the Go counterpart of the phone page's XState
// model tests; here the model is the fake Mac below plus the rules, not a
// statechart.

import (
	"fmt"
	"slices"
	"testing"

	"pgregory.net/rapid"
)

// partyApp is an app that may be running on the fake Mac.
type partyApp struct {
	info    SourceInfo // pids filled in while running
	running bool
}

// modelMac is the world the engine sees, plus a record of what it did.
type modelMac struct {
	apps    []*partyApp
	inputs  map[string]bool // uid -> plugged in
	nextPID int
	fail    map[string]bool // sources whose capture fails to start
	running []SourceInfo    // captures in progress
}

func newModelMac() *modelMac {
	m := &modelMac{inputs: map[string]bool{"mixtour": false, "scarlett": false}, nextPID: 100, fail: map[string]bool{}}
	for _, a := range []SourceInfo{
		{ID: "app:/Applications/djay Pro.app", Kind: KindApp, Label: "djay Pro", DJ: true},
		{ID: "app:/Applications/rekordbox.app", Kind: KindApp, Label: "rekordbox", DJ: true},
		{ID: "app:/Applications/Spotify.app", Kind: KindApp, Label: "Spotify"},
		{ID: "app:/Applications/Music.app", Kind: KindApp, Label: "Music"},
	} {
		m.apps = append(m.apps, &partyApp{info: a})
	}
	return m
}

func (m *modelMac) scan() []SourceInfo {
	out := []SourceInfo{systemSource}
	for _, a := range m.apps {
		if a.running {
			out = append(out, a.info)
		}
	}
	for _, uid := range []string{"mixtour", "scarlett"} {
		if m.inputs[uid] {
			out = append(out, SourceInfo{ID: "input:" + uid, Kind: KindInput, Label: uid, uid: uid})
		}
	}
	return append(out, toneSource)
}

type modelSource struct {
	m    *modelMac
	info SourceInfo
}

func (s *modelSource) Start(AudioFunc) error {
	s.m.running = append(s.m.running, s.info)
	return nil
}

func (s *modelSource) Stop() {
	s.m.running = slices.DeleteFunc(s.m.running, func(r SourceInfo) bool { return r.ID == s.info.ID })
}

func (m *modelMac) open(s SourceInfo) (Source, error) {
	if m.fail[s.ID] {
		return nil, fmt.Errorf("macOS said no")
	}
	return &modelSource{m: m, info: s}, nil
}

func TestEngineModel(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		m := newModelMac()
		// Some apps and inputs may already be there when the app opens.
		for _, a := range m.apps {
			if rapid.Bool().Draw(t, "running at start: "+a.info.Label) {
				m.launch(a)
			}
		}
		saved := Settings{Name: "x", Kbps: 192, Visual: defaultVisual}
		if rapid.Bool().Draw(t, "has a saved pick") {
			saved.Source = rapid.SampledFrom(m.scan()).Draw(t, "saved pick").ID
		}

		enc, err := NewEncoder(192, func([]byte) {})
		if err != nil {
			t.Fatal(err)
		}
		hub := NewHub(Meta{})
		e := NewEngine(hub, nil, enc, saved, "")
		e.scan, e.open = m.scan, m.open
		e.live.Store(false)
		enc.SetMuted(true)
		e.sources = e.scan()
		first, auto := e.pickInitial("")
		e.auto = auto
		e.apply(first)

		userPick := ""
		if !auto {
			userPick = first.ID
		}
		live := false
		check := func(step string) {
			t.Helper()
			checkEngineRules(t, step, e, m, userPick, live)
		}
		check("start")

		t.Repeat(map[string]func(*rapid.T){
			"open an app": func(t *rapid.T) {
				a := rapid.SampledFrom(m.apps).Draw(t, "app")
				if !a.running {
					m.launch(a)
				}
			},
			"quit an app": func(t *rapid.T) {
				a := rapid.SampledFrom(m.apps).Draw(t, "app")
				a.running = false
				a.info.pids = nil
			},
			"an app restarts": func(t *rapid.T) {
				a := rapid.SampledFrom(m.apps).Draw(t, "app")
				if a.running {
					m.launch(a) // new pid
				}
			},
			"an app starts or stops playing": func(t *rapid.T) {
				a := rapid.SampledFrom(m.apps).Draw(t, "app")
				a.info.Playing = !a.info.Playing
			},
			"plug or unplug an input": func(t *rapid.T) {
				uid := rapid.SampledFrom([]string{"mixtour", "scarlett"}).Draw(t, "input")
				m.inputs[uid] = !m.inputs[uid]
			},
			"macOS blocks or allows a source": func(t *rapid.T) {
				s := rapid.SampledFrom(m.scan()).Draw(t, "source")
				m.fail[s.ID] = !m.fail[s.ID]
			},
			"the engine rescans": func(t *rapid.T) {
				before := e.current
				status := e.status
				pids := slices.Clone(e.pids)
				e.rescan()
				checkRescanRules(t, e, m, before, status, pids)
				check("rescan")
			},
			"the DJ picks a source": func(t *rapid.T) {
				s := rapid.SampledFrom(e.sources).Draw(t, "pick")
				if !e.SetSource(s.ID) {
					t.Fatalf("picking %q from the list failed", s.ID)
				}
				userPick = s.ID
				// Picking always takes effect straight away.
				switch {
				case e.current.ID != s.ID:
					t.Fatalf("picked %q but current is %q", s.ID, e.current.ID)
				case m.fail[s.ID] && e.status != StatusError:
					t.Fatalf("a blocked source should report an error, got %s", e.status)
				case !m.fail[s.ID] && e.status != StatusCapturing:
					t.Fatalf("picked %q from the list but status is %s", s.ID, e.status)
				}
				if e.settings.Source != s.ID {
					t.Fatalf("pick not saved: %q", e.settings.Source)
				}
				check("pick")
			},
			"the DJ goes live or off air": func(t *rapid.T) {
				live = !live
				before := e.current.ID
				e.SetLive(live)
				if e.current.ID != before {
					t.Fatal("going live or off air changed the source")
				}
				check("live")
			},
			"": func(t *rapid.T) { check("any step") },
		})
	})
}

func (m *modelMac) launch(a *partyApp) {
	a.running = true
	m.nextPID++
	a.info.pids = []int{m.nextPID}
}

// checkEngineRules are the rules that hold after every step.
func checkEngineRules(t *rapid.T, step string, e *Engine, m *modelMac, userPick string, live bool) {
	// Exactly one capture while capturing, of the current source and the
	// processes it last saw; none otherwise. Never two at once.
	switch e.status {
	case StatusCapturing:
		if len(m.running) != 1 || m.running[0].ID != e.current.ID {
			t.Fatalf("%s: capturing %q but running %v", step, e.current.ID, ids(m.running))
		}
		if !slices.Equal(m.running[0].pids, e.pids) {
			t.Fatalf("%s: tapping pids %v, engine thinks %v", step, m.running[0].pids, e.pids)
		}
	case StatusWaiting, StatusError:
		if len(m.running) != 0 {
			t.Fatalf("%s: %s but captures running %v", step, e.status, ids(m.running))
		}
	default:
		t.Fatalf("%s: unknown status %q", step, e.status)
	}
	// An error always says what went wrong; other states carry no error.
	if (e.status == StatusError) != (e.errMsg != "") {
		t.Fatalf("%s: status %s with error %q", step, e.status, e.errMsg)
	}
	// Once the DJ has picked, the engine never switches away on its own.
	if userPick != "" {
		if e.auto {
			t.Fatalf("%s: still auto after the DJ picked", step)
		}
		if e.current.ID != userPick {
			t.Fatalf("%s: DJ picked %q but engine moved to %q", step, userPick, e.current.ID)
		}
	}
	// Only apps and inputs can be waited for.
	if e.status == StatusWaiting && e.current.Kind != KindApp && e.current.Kind != KindInput {
		t.Fatalf("%s: waiting for %s", step, e.current.Kind)
	}
	// Phones are told the truth about being live, and only hear audio then.
	if e.Live() != live || e.hub.meta.Live != live || e.enc.muted.Load() == live {
		t.Fatalf("%s: live should be %v (engine %v, phones told %v, muted %v)", step, live, e.Live(), e.hub.meta.Live, e.enc.muted.Load())
	}
}

// checkRescanRules say what a rescan must do, given what was there before.
func checkRescanRules(t *rapid.T, e *Engine, m *modelMac, before SourceInfo, status string, pids []int) {
	now, present := findSource(m.scan(), before.ID)
	switch {
	case e.auto && before.Kind == KindSystem:
		// Automatic system audio gives way to DJ software when it shows up.
		if dj, ok := bestDJApp(m.scan()); ok && e.current.ID != dj.ID {
			t.Fatalf("auto: %s is open but still on %s", dj.Label, e.current.ID)
		}
	case before.Kind == KindApp && !present:
		// The app quit: wait for it, under the same name.
		if e.current.ID != before.ID || e.status != StatusWaiting || e.current.Label != before.Label {
			t.Fatalf("%s quit: now %q %s (%q)", before.Label, e.current.ID, e.status, e.current.Label)
		}
	case before.Kind == KindApp && !slices.Equal(now.pids, pids):
		// It came back or restarted: follow it to its new processes.
		if e.current.ID != before.ID || (!m.fail[before.ID] && (e.status != StatusCapturing || !slices.Equal(e.pids, now.pids))) {
			t.Fatalf("%s restarted: now %q %s %v", before.Label, e.current.ID, e.status, e.pids)
		}
	case before.Kind == KindApp && status == StatusError:
		// Same processes and it failed before: don't hammer macOS every scan.
		if e.status != StatusError {
			t.Fatalf("retried a failed capture of %s without anything changing", before.Label)
		}
	case before.Kind == KindInput && !present:
		if e.current.ID != before.ID || e.status != StatusWaiting {
			t.Fatalf("input unplugged: now %q %s", e.current.ID, e.status)
		}
	case before.Kind == KindInput && status == StatusWaiting:
		// Plugged back in: resume.
		if !m.fail[before.ID] && e.status != StatusCapturing {
			t.Fatalf("input plugged back in but %s", e.status)
		}
	}
	// A rescan always leaves the source list current.
	if !sameSources(e.sources, m.scan()) {
		t.Fatal("source list is stale after a rescan")
	}
}

func ids(list []SourceInfo) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = s.ID
	}
	return out
}
