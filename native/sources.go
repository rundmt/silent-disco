package main

// What the DJ can pick as the audio source, and how DJ software is spotted.

import (
	"net/url"
	"path"
	"slices"
	"sort"
	"strings"
)

const (
	KindSystem = "system" // everything the Mac plays
	KindApp    = "app"    // one app, via a process tap
	KindInput  = "input"  // an input device: interface, mixer USB out, BlackHole
	KindTone   = "tone"   // test tone
)

type SourceInfo struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Detail  string `json:"detail,omitempty"`
	DJ      bool   `json:"dj,omitempty"`      // known DJ software
	Playing bool   `json:"playing,omitempty"` // making sound right now
	Icon    string `json:"icon,omitempty"`    // URL of the app icon

	pids []int  // app: processes to tap
	uid  string // input: Core Audio device UID
}

var systemSource = SourceInfo{ID: KindSystem, Kind: KindSystem, Label: "All system audio", Detail: "Everything this Mac plays"}
var toneSource = SourceInfo{ID: KindTone, Kind: KindTone, Label: "Test tone", Detail: "A gentle chord, for checking phones"}

// djNames are lowercase fragments of DJ software names and bundle ids. Any
// app can still be picked by hand; these just float to the top and get
// chosen automatically.
var djNames = []string{
	"djay", "rekordbox", "serato", "traktor", "virtualdj", "virtual dj",
	"mixxx", "engine dj", "enginedj", "cross dj", "crossdj", "mixvibes",
	"deckadance", "dex 3", "dex3", "djuced", "pcdj", "ultramixer", "dj.studio",
}

func isDJApp(name, bundle, appPath string) bool {
	hay := strings.ToLower(name + " " + bundle + " " + path.Base(appPath))
	for _, n := range djNames {
		if strings.Contains(hay, n) {
			return true
		}
	}
	return false
}

// audioProcess is one process Core Audio knows about.
type audioProcess struct {
	pid     int
	playing bool
	appPath string // the .app it belongs to; empty for bare processes
	name    string
	bundle  string
}

// groupApps folds processes into one entry per app (DJ apps and browsers
// play through helper processes) and orders them: DJ software first, then
// whatever is making sound, then the rest.
func groupApps(procs []audioProcess) []SourceInfo {
	byID := map[string]*SourceInfo{}
	var order []string
	for _, p := range procs {
		id := "app:" + p.appPath
		if p.appPath == "" {
			id = "proc:" + p.name
		}
		s := byID[id]
		if s == nil {
			s = &SourceInfo{ID: id, Kind: KindApp, Label: p.name, DJ: isDJApp(p.name, p.bundle, p.appPath)}
			if p.appPath != "" {
				s.Icon = "/api/icon?app=" + url.QueryEscape(p.appPath)
			}
			byID[id] = s
			order = append(order, id)
		}
		s.pids = append(s.pids, p.pid)
		s.Playing = s.Playing || p.playing
	}
	out := make([]SourceInfo, 0, len(order))
	for _, id := range order {
		s := byID[id]
		// Background daemons only matter while they're making sound.
		if strings.HasPrefix(id, "proc:") && !s.Playing && !s.DJ {
			continue
		}
		sort.Ints(s.pids)
		switch {
		case s.DJ && s.Playing:
			s.Detail = "DJ software · playing"
		case s.DJ:
			s.Detail = "DJ software"
		case s.Playing:
			s.Detail = "Playing now"
		}
		out = append(out, *s)
	}
	rank := func(s SourceInfo) int {
		switch {
		case s.DJ && s.Playing:
			return 0
		case s.DJ:
			return 1
		case s.Playing:
			return 2
		}
		return 3
	}
	sort.SliceStable(out, func(i, j int) bool {
		if ri, rj := rank(out[i]), rank(out[j]); ri != rj {
			return ri < rj
		}
		return strings.ToLower(out[i].Label) < strings.ToLower(out[j].Label)
	})
	return out
}

// findSource looks a source up by id.
func findSource(list []SourceInfo, id string) (SourceInfo, bool) {
	for _, s := range list {
		if s.ID == id {
			return s, true
		}
	}
	return SourceInfo{}, false
}

// matchSource finds a source by a loose name, for the -app and -input flags.
func matchSource(list []SourceInfo, kind, query string) (SourceInfo, bool) {
	q := strings.ToLower(query)
	for _, s := range list {
		if s.Kind == kind && (strings.Contains(strings.ToLower(s.Label), q) || strings.Contains(strings.ToLower(s.ID), q)) {
			return s, true
		}
	}
	return SourceInfo{}, false
}

// bestDJApp is the DJ app to pick automatically: one that's playing, else
// any that's open.
func bestDJApp(list []SourceInfo) (SourceInfo, bool) {
	i := slices.IndexFunc(list, func(s SourceInfo) bool { return s.Kind == KindApp && s.DJ })
	if i < 0 {
		return SourceInfo{}, false
	}
	return list[i], true // groupApps puts playing DJ apps first
}
