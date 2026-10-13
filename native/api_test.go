package main

// Tests for the DJ console's API, through the same mux the app serves.

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"pgregory.net/rapid"
)

type consoleClient struct {
	t     testing.TB
	srv   *httptest.Server
	api   *consoleAPI
	e     *Engine
	mux   *http.ServeMux
	token string
}

func newConsoleClient(t testing.TB) *consoleClient {
	t.Helper()
	e, api, mux, err := newStation(defaultSettings, "")
	if err != nil {
		t.Fatal(err)
	}
	e.Start(KindTone, false)
	srv := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Close(); e.Stop() })
	return &consoleClient{t: t, srv: srv, api: api, e: e, mux: mux, token: api.token}
}

// do sends a request with the token in the header and returns status and body.
func (c *consoleClient) do(method, path, body string) (int, string) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.srv.URL+path, strings.NewReader(body))
	req.Header.Set("X-Token", c.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func (c *consoleClient) state(body string) State {
	c.t.Helper()
	var s State
	if err := json.Unmarshal([]byte(body), &s); err != nil {
		c.t.Fatalf("not a state: %q", body)
	}
	return s
}

func TestConsoleAPIGuard(t *testing.T) {
	c := newConsoleClient(t)
	get := func(path string, header string) int {
		req, _ := http.NewRequest("GET", c.srv.URL+path, nil)
		if header != "" {
			req.Header.Set("X-Token", header)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for _, tc := range []struct {
		name, path, header string
		want               int
	}{
		{"no token", "/api/state", "", 403},
		{"wrong token", "/api/state", "nope", 403},
		{"token prefix", "/api/state", c.token[:10], 403},
		{"header token", "/api/state", c.token, 200},
		{"query token (EventSource, img)", "/api/state?t=" + c.token, "", 200},
		{"wrong query token", "/api/state?t=nope", "", 403},
	} {
		if got := get(tc.path, tc.header); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}

	// From another device on the Wi-Fi, even with the right token.
	for _, path := range []string{"/api/state", "/api/live", "/api/flash"} {
		method := "POST"
		if path == "/api/state" {
			method = "GET"
		}
		req := httptest.NewRequest(method, path, strings.NewReader(`{"live":true}`))
		req.RemoteAddr = "192.168.1.23:51000"
		req.Header.Set("X-Token", c.token)
		w := httptest.NewRecorder()
		c.mux.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Errorf("%s from the LAN: %d, want 403", path, w.Code)
		}
	}
	if c.e.Live() {
		t.Fatal("a phone on the Wi-Fi put the party on air")
	}

	// The phone side refuses to act as the DJ.
	if got := get("/events?role=host", ""); got != 403 {
		t.Errorf("host event stream: %d, want 403", got)
	}
}

func TestConsoleAPISourceAndLive(t *testing.T) {
	c := newConsoleClient(t)
	if code, _ := c.do("POST", "/api/source", `{"id":"app:/Applications/Nope.app"}`); code != 404 {
		t.Fatalf("unknown source: %d, want 404", code)
	}
	if code, _ := c.do("POST", "/api/source", `{"id":`); code != 400 {
		t.Fatalf("broken json: %d, want 400", code)
	}
	code, body := c.do("POST", "/api/source", `{"id":"tone"}`)
	if s := c.state(body); code != 200 || s.Source.ID != KindTone || s.Status != StatusCapturing || s.Auto {
		t.Fatalf("pick tone: %d %+v", code, s)
	}

	_, body = c.do("POST", "/api/live", `{"live":true}`)
	if s := c.state(body); !s.Live || !c.e.hub.meta.Live || c.e.enc.muted.Load() {
		t.Fatalf("go live: %+v", s)
	}
	_, body = c.do("POST", "/api/live", `{"live":false}`)
	if s := c.state(body); s.Live || c.e.hub.meta.Live || !c.e.enc.muted.Load() {
		t.Fatalf("off air: %+v", s)
	}
}

func TestConsoleAPISettings(t *testing.T) {
	c := newConsoleClient(t)
	for _, tc := range []struct {
		body string
		name string
		kbps int
	}{
		{`{"name":"  Rooftop  "}`, "Rooftop", 192},
		{`{"name":"   "}`, "Silent Disco", 192},
		{`{"kbps":96}`, "Silent Disco", 96},
		{`{"kbps":9999}`, "Silent Disco", 256},
		{`{"kbps":1}`, "Silent Disco", 64},
		{`{}`, "Silent Disco", 64},
	} {
		code, body := c.do("POST", "/api/settings", tc.body)
		s := c.state(body)
		if code != 200 || s.Name != tc.name || s.Kbps != tc.kbps {
			t.Errorf("%s: %d name %q kbps %d, want %q %d", tc.body, code, s.Name, s.Kbps, tc.name, tc.kbps)
		}
		if c.e.hub.meta.Name != s.Name {
			t.Errorf("%s: phones told %q", tc.body, c.e.hub.meta.Name)
		}
	}
}

// Any name the DJ types becomes something phones can show.
func TestConsoleNameProperty(t *testing.T) {
	c := newConsoleClient(t)
	rapid.Check(t, func(rt *rapid.T) {
		name := rapid.String().Draw(rt, "name")
		body, _ := json.Marshal(map[string]string{"name": name})
		_, res := c.do("POST", "/api/settings", string(body))
		got := c.state(res).Name
		switch {
		case got == "":
			rt.Fatal("empty name")
		case utf8.RuneCountInString(got) > 60:
			rt.Fatalf("%d characters", utf8.RuneCountInString(got))
		case got != strings.TrimSpace(got) && utf8.RuneCountInString(strings.TrimSpace(name)) <= 60:
			rt.Fatalf("untrimmed %q", got)
		case !strings.HasPrefix(strings.TrimSpace(strings.ToValidUTF8(name, "�")), got) && got != "Silent Disco":
			rt.Fatalf("%q became %q", name, got)
		}
	})
}

func TestConsoleAPIVisualAndFlash(t *testing.T) {
	c := newConsoleClient(t)
	msgs, cancel := listen(t, c.srv.URL, "")
	defer cancel()
	waitFor(t, msgs, "welcome")

	for _, bad := range []string{`{"style":"spiral","palette":"neon"}`, `{"style":"bars","palette":"rainbow"}`, `{}`} {
		if code, _ := c.do("POST", "/api/visual", bad); code != 400 {
			t.Errorf("visual %s: %d, want 400", bad, code)
		}
	}
	code, body := c.do("POST", "/api/visual", `{"style":"bars","palette":"sunset"}`)
	if s := c.state(body); code != 200 || s.Visual != (Visual{"bars", "sunset"}) {
		t.Fatalf("visual: %d %+v", code, s.Visual)
	}
	// Phones hear about it straight away.
	var meta Meta
	json.Unmarshal(waitFor(t, msgs, "meta").Meta, &meta)
	if meta.Visual != (Visual{"bars", "sunset"}) {
		t.Fatalf("phones told %+v", meta.Visual)
	}

	for _, bad := range []string{`{"color":"red"}`, `{"color":"#ff00aa;"}`, `{"color":"#fff"}`, `{}`} {
		if code, _ := c.do("POST", "/api/flash", bad); code != 400 {
			t.Errorf("flash %s: %d, want 400", bad, code)
		}
	}
	if code, _ := c.do("POST", "/api/flash", `{"color":"#22DDff"}`); code != 200 {
		t.Fatalf("flash: %d", code)
	}
	if f := waitFor(t, msgs, "flash"); f.Color != "#22DDff" {
		t.Fatalf("phones flashed %q", f.Color)
	}
}

func TestConsoleAPIEvents(t *testing.T) {
	c := newConsoleClient(t)
	res, err := http.Get(c.srv.URL + "/api/events?t=" + c.token)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	seen := map[string]bool{}
	for sc.Scan() && !(seen["state"] && seen["tick"]) {
		if v, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
			var m struct{ Type string }
			json.Unmarshal([]byte(v), &m)
			seen[m.Type] = true
		}
	}
	if !seen["state"] || !seen["tick"] {
		t.Fatalf("console stream sent %v, want state and tick", seen)
	}
}
