package main

// The DJ console's API. Only this Mac can use it, and every request must
// carry the random token the app window was opened with, so web pages open
// in a browser can't drive it either.

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

type consoleAPI struct {
	e     *Engine
	token string

	iconMu sync.Mutex
	icons  map[string][]byte
}

func newConsoleAPI(e *Engine) *consoleAPI {
	return &consoleAPI{e: e, token: newID(), icons: map[string][]byte{}}
}

func (a *consoleAPI) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/state", a.guard(a.state))
	mux.HandleFunc("GET /api/events", a.guard(a.events))
	mux.HandleFunc("GET /api/icon", a.guard(a.icon))
	mux.HandleFunc("POST /api/source", a.guard(a.source))
	mux.HandleFunc("POST /api/live", a.guard(a.live))
	mux.HandleFunc("POST /api/settings", a.guard(a.settings))
	mux.HandleFunc("POST /api/privacy", a.guard(a.privacy))
	mux.HandleFunc("POST /api/visual", a.guard(a.visual))
	mux.HandleFunc("POST /api/flash", a.guard(a.flash))
}

// consoleURL is where the app window points.
func (a *consoleAPI) consoleURL(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d/console.html#t=%s", port, a.token)
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return err == nil && ip != nil && ip.IsLoopback()
}

func (a *consoleAPI) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get("X-Token")
		if tok == "" {
			tok = r.URL.Query().Get("t") // EventSource and <img> can't set headers
		}
		if !isLoopback(r) || subtle.ConstantTimeCompare([]byte(tok), []byte(a.token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(v); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return false
	}
	return true
}

func (a *consoleAPI) state(w http.ResponseWriter, r *http.Request) { writeJSON(w, a.e.State()) }

// Tick is the frequent, small update: level meter and listener counts.
type Tick struct {
	Type      string  `json:"type"`
	Level     float32 `json:"level"`
	Listeners int     `json:"listeners"` // phones receiving audio
	Open      int     `json:"open"`      // phones with the page open
}

// events streams the full state when it changes and a tick ten times a second.
func (a *consoleAPI) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	changes, cancel := a.e.Subscribe()
	defer cancel()
	send := func(v any) {
		data, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}
	sendState := func() {
		send(struct {
			Type string `json:"type"`
			State
		}{"state", a.e.State()})
	}
	sendState()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-changes:
			sendState()
		case <-tick.C:
			send(Tick{Type: "tick", Level: a.e.Level(), Listeners: a.e.bc.connected(), Open: a.e.hub.Count()})
		}
	}
}

func (a *consoleAPI) icon(w http.ResponseWriter, r *http.Request) {
	app := r.URL.Query().Get("app")
	a.iconMu.Lock()
	png, ok := a.icons[app]
	a.iconMu.Unlock()
	if !ok {
		if png, ok = appIcon(app); !ok {
			http.NotFound(w, r)
			return
		}
		a.iconMu.Lock()
		a.icons[app] = png
		a.iconMu.Unlock()
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Write(png)
}

func (a *consoleAPI) source(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID string }
	if !decode(w, r, &body) {
		return
	}
	if !a.e.SetSource(body.ID) {
		http.Error(w, "that source is gone", http.StatusNotFound)
		return
	}
	writeJSON(w, a.e.State())
}

func (a *consoleAPI) live(w http.ResponseWriter, r *http.Request) {
	var body struct{ Live bool }
	if !decode(w, r, &body) {
		return
	}
	a.e.SetLive(body.Live)
	writeJSON(w, a.e.State())
}

func (a *consoleAPI) settings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string
		Kbps *int
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Name != nil {
		a.e.SetName(*body.Name)
	}
	if body.Kbps != nil {
		a.e.SetKbps(*body.Kbps)
	}
	writeJSON(w, a.e.State())
}

func (a *consoleAPI) privacy(w http.ResponseWriter, r *http.Request) {
	var body struct{ Kind string }
	if !decode(w, r, &body) {
		return
	}
	openPrivacySettings(body.Kind)
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *consoleAPI) visual(w http.ResponseWriter, r *http.Request) {
	var v Visual
	if !decode(w, r, &v) {
		return
	}
	if !a.e.SetVisual(v) {
		http.Error(w, "unknown style or palette", http.StatusBadRequest)
		return
	}
	writeJSON(w, a.e.State())
}

func (a *consoleAPI) flash(w http.ResponseWriter, r *http.Request) {
	var body struct{ Color string }
	if !decode(w, r, &body) {
		return
	}
	if !a.e.Flash(body.Color) {
		http.Error(w, "bad color", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
