package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// openStream connects like EventSource and returns the welcome's id.
func openStream(t *testing.T, url, lastID string) (string, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", url+"/events?role=listener", nil)
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(res.Body)
	var eventID string
	for sc.Scan() {
		line := sc.Text()
		if v, ok := strings.CutPrefix(line, "id: "); ok {
			eventID = v
		}
		if v, ok := strings.CutPrefix(line, "data: "); ok {
			var msg struct{ Type, ID string }
			json.Unmarshal([]byte(v), &msg)
			if msg.Type == "welcome" {
				if eventID != msg.ID {
					t.Fatalf("event id %q doesn't carry the client id %q", eventID, msg.ID)
				}
				return msg.ID, cancel
			}
		}
	}
	t.Fatal("no welcome")
	return "", cancel
}

func TestStreamResumesWithSameIDAndKeepsAudio(t *testing.T) {
	hub := NewHub(Meta{Name: "x"})
	var left atomic.Int32
	active := atomic.Bool{}
	active.Store(true)
	hub.OnLeave = func(string) { left.Add(1) }
	hub.OnActive = func(string) bool { return active.Load() }
	srv := httptest.NewServer(http.HandlerFunc(hub.ServeEvents))
	defer srv.Close()

	id, cancel := openStream(t, srv.URL, "")
	cancel() // Chrome goes to the background
	time.Sleep(50 * time.Millisecond)
	if left.Load() != 0 {
		t.Fatal("a dropped stream should not end the audio connection")
	}

	again, cancel2 := openStream(t, srv.URL, id)
	defer cancel2()
	if again != id {
		t.Fatalf("resumed as %q, want %q", again, id)
	}

	// A stranger's made-up id gets a fresh one.
	other, cancel3 := openStream(t, srv.URL, "not-a-client")
	defer cancel3()
	if other == id || other == "not-a-client" {
		t.Fatalf("unexpected id %q", other)
	}
}

func TestDetachedPhoneIsForgottenOnceAudioEnds(t *testing.T) {
	hub := NewHub(Meta{})
	var left atomic.Int32
	active := atomic.Bool{}
	active.Store(true)
	hub.OnLeave = func(string) { left.Add(1) }
	hub.OnActive = func(string) bool { return active.Load() }
	c, stop := hub.attach("")
	hub.detach(c, stop)

	hub.checkDetached(c) // audio still flowing: kept
	if left.Load() != 0 || hub.Count() != 1 {
		t.Fatal("forgot a phone that is still listening")
	}
	active.Store(false)
	hub.checkDetached(c)
	if left.Load() != 1 || hub.Count() != 0 {
		t.Fatal("kept a phone with no stream and no audio")
	}
}
