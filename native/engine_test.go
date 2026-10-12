package main

import (
	"errors"
	"slices"
	"testing"
)

type fakeSource struct {
	info    SourceInfo
	running *[]string
}

func (f *fakeSource) Start(AudioFunc) error {
	*f.running = append(*f.running, f.info.ID)
	return nil
}

func (f *fakeSource) Stop() {
	*f.running = slices.DeleteFunc(*f.running, func(id string) bool { return id == f.info.ID })
}

// fakeMac lets a test open and quit apps and plug inputs in and out.
type fakeMac struct {
	sources []SourceInfo
	running []string // ids of captures in progress
	fail    map[string]bool
}

func (m *fakeMac) open(s SourceInfo) (Source, error) {
	if m.fail[s.ID] {
		return nil, errors.New("blocked")
	}
	return &fakeSource{info: s, running: &m.running}, nil
}

func (m *fakeMac) scan() []SourceInfo {
	return append([]SourceInfo{systemSource}, m.sources...)
}

var (
	djay     = SourceInfo{ID: "app:/Applications/djay Pro.app", Kind: KindApp, Label: "djay Pro", DJ: true, pids: []int{10}}
	spotify  = SourceInfo{ID: "app:/Applications/Spotify.app", Kind: KindApp, Label: "Spotify", Playing: true, pids: []int{20}}
	mixtour  = SourceInfo{ID: "input:mixtour", Kind: KindInput, Label: "Mixtour Pro", uid: "mixtour"}
	serato   = SourceInfo{ID: "app:/Applications/Serato DJ Pro.app", Kind: KindApp, Label: "Serato DJ Pro", DJ: true, pids: []int{30}}
	djayBack = SourceInfo{ID: djay.ID, Kind: KindApp, Label: "djay Pro", DJ: true, pids: []int{11}}
)

func newTestEngine(m *fakeMac, saved Settings) *Engine {
	e := NewEngine(NewHub(Meta{}), nil, nil, saved, "")
	e.scan, e.open = m.scan, m.open
	return e
}

func (e *Engine) startForTest(prefer string) {
	e.sources = e.scan()
	first, auto := e.pickInitial(prefer)
	e.auto = auto
	e.apply(first)
}

func expect(t *testing.T, e *Engine, m *fakeMac, id, status string) {
	t.Helper()
	if e.current.ID != id || e.status != status {
		t.Fatalf("source %q (%s), want %q (%s)", e.current.ID, e.status, id, status)
	}
	want := []string{}
	if status == StatusCapturing {
		want = []string{id}
	}
	if !slices.Equal(m.running, want) && !(len(m.running) == 0 && len(want) == 0) {
		t.Fatalf("captures running %v, want %v", m.running, want)
	}
}

func TestPicksOpenDJAppAutomatically(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{spotify, djay}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")
	expect(t, e, m, djay.ID, StatusCapturing)
}

func TestFallsBackToSystemAudioThenSwitchesWhenDJAppOpens(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{spotify}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")
	expect(t, e, m, KindSystem, StatusCapturing)

	m.sources = []SourceInfo{spotify, serato}
	e.rescan()
	expect(t, e, m, serato.ID, StatusCapturing)
}

func TestDJsOwnChoiceOfSystemAudioSticks(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{spotify}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")
	e.SetSource(KindSystem)
	m.sources = []SourceInfo{spotify, serato}
	e.rescan()
	expect(t, e, m, KindSystem, StatusCapturing)
}

func TestFollowsDJAppThroughRestart(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{djay}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")

	m.sources = nil // djay crashes
	e.rescan()
	expect(t, e, m, djay.ID, StatusWaiting)
	if e.current.Label != "djay Pro" {
		t.Fatalf("waiting label %q", e.current.Label)
	}

	m.sources = []SourceInfo{djayBack} // relaunched with a new pid
	e.rescan()
	expect(t, e, m, djay.ID, StatusCapturing)
	if !slices.Equal(e.pids, []int{11}) {
		t.Fatalf("tapping pids %v", e.pids)
	}
}

func TestInputUnpluggedAndBack(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{djay, mixtour}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")
	if !e.SetSource(mixtour.ID) {
		t.Fatal("could not pick the input")
	}
	expect(t, e, m, mixtour.ID, StatusCapturing)

	m.sources = []SourceInfo{djay}
	e.rescan()
	expect(t, e, m, mixtour.ID, StatusWaiting)

	m.sources = []SourceInfo{djay, mixtour}
	e.rescan()
	expect(t, e, m, mixtour.ID, StatusCapturing)
}

func TestRemembersLastPick(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{djay, mixtour}}
	e := newTestEngine(m, Settings{Name: "x", Kbps: 192, Source: mixtour.ID})
	e.startForTest("")
	expect(t, e, m, mixtour.ID, StatusCapturing)
	if e.auto {
		t.Fatal("a remembered pick should not be replaced automatically")
	}
}

func TestCommandLineWins(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{djay, spotify}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest(spotify.ID)
	expect(t, e, m, spotify.ID, StatusCapturing)
}

func TestCaptureErrorIsReportedNotRetriedInALoop(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{djay}, fail: map[string]bool{djay.ID: true}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")
	expect(t, e, m, djay.ID, StatusError)
	e.rescan()
	expect(t, e, m, djay.ID, StatusError)

	delete(m.fail, djay.ID)
	e.SetSource(djay.ID) // picking it again retries
	expect(t, e, m, djay.ID, StatusCapturing)
}

func TestSilenceIsNoticedAfterThreeSeconds(t *testing.T) {
	m := &fakeMac{sources: []SourceInfo{djay}}
	e := newTestEngine(m, defaultSettings)
	e.startForTest("")
	for i := 0; i < 59; i++ {
		e.tickLevel(0)
	}
	if e.silent {
		t.Fatal("silent too early")
	}
	e.tickLevel(0)
	if !e.silent {
		t.Fatal("silence not noticed")
	}
	e.tickLevel(0.3)
	if e.silent {
		t.Fatal("sound did not clear the silence warning")
	}
}

func TestGroupAppsPutsDJSoftwareFirst(t *testing.T) {
	got := groupApps([]audioProcess{
		{pid: 1, appPath: "/Applications/Google Chrome.app", name: "Google Chrome", playing: true},
		{pid: 2, appPath: "/Applications/Google Chrome.app", name: "Google Chrome"},
		{pid: 3, name: "callservicesd"},
		{pid: 4, appPath: "/Applications/rekordbox 7/rekordbox.app", name: "rekordbox", bundle: "com.pioneerdj.rekordboxdj"},
		{pid: 5, appPath: "/Applications/Music.app", name: "Music"},
		{pid: 6, appPath: "/Applications/djay Pro AI.app", name: "djay Pro AI", playing: true},
	})
	var labels []string
	for _, s := range got {
		labels = append(labels, s.Label)
	}
	want := []string{"djay Pro AI", "rekordbox", "Google Chrome", "Music"}
	if !slices.Equal(labels, want) {
		t.Fatalf("got %v, want %v", labels, want)
	}
	if !slices.Equal(got[2].pids, []int{1, 2}) {
		t.Fatalf("chrome helpers not grouped: %v", got[2].pids)
	}
}
