package main

// End-to-end audio test: the real station (hub, WebRTC broadcaster, Opus
// encoder, engine) plays the test tone to a fake phone built from Pion, the
// same WebRTC library on the other side. The phone decodes what it hears
// and checks the chord arrived with left and right the right way round,
// then loses its event stream (as Android does in the background) and checks
// the music keeps going and it gets its old id back.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"gopkg.in/hraban/opus.v2"
)

type sseMsg struct {
	EventID string
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	SDP     string          `json:"sdp"`
	Meta    json.RawMessage `json:"meta"`
	Color   string          `json:"color"`
}

// listen opens the phone's event stream and delivers its messages.
func listen(t *testing.T, base, lastID string) (<-chan sseMsg, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/events?role=listener", nil)
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan sseMsg, 32)
	go func() {
		defer close(out)
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		eventID := ""
		for sc.Scan() {
			line := sc.Text()
			if v, ok := strings.CutPrefix(line, "id: "); ok {
				eventID = v
			}
			if v, ok := strings.CutPrefix(line, "data: "); ok {
				var m sseMsg
				json.Unmarshal([]byte(v), &m)
				m.EventID = eventID
				out <- m
			}
		}
	}()
	return out, cancel
}

func waitFor(t *testing.T, msgs <-chan sseMsg, typ string) sseMsg {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				t.Fatalf("stream ended waiting for %s", typ)
			}
			if m.Type == typ {
				return m
			}
		case <-timeout:
			t.Fatalf("no %s message", typ)
		}
	}
}

func postSignal(t *testing.T, base string, msg map[string]any) {
	t.Helper()
	body, _ := json.Marshal(msg)
	res, err := http.Post(base+"/signal", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("signal %v: %s", msg["type"], res.Status)
	}
}

// fakePhone is a WebRTC receiver that decodes the Opus it gets.
type fakePhone struct {
	pc      *webrtc.PeerConnection
	packets atomic.Int64
	mu      sync.Mutex
	pcm     []float32 // interleaved stereo, 48 kHz
}

func newFakePhone(t *testing.T) *fakePhone {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &fakePhone{pc: pc}
	dec, err := opus.NewDecoder(sampleRate, channels)
	if err != nil {
		t.Fatal(err)
	}
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		buf := make([]float32, 5760*channels)
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			p.packets.Add(1)
			n, err := dec.DecodeFloat32(pkt.Payload, buf)
			if err != nil {
				continue
			}
			p.mu.Lock()
			p.pcm = append(p.pcm, buf[:n*channels]...)
			p.mu.Unlock()
		}
	})
	t.Cleanup(func() { pc.Close() })
	return p
}

// answer takes the station's offer and returns a complete answer.
func (p *fakePhone) answer(t *testing.T, offer string) string {
	t.Helper()
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatal(err)
	}
	ans, err := p.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(ans); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return p.pc.LocalDescription().SDP
}

// lastSeconds returns the most recent d of decoded audio, split by channel.
func (p *fakePhone) lastSeconds(d float64) (left, right []float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := int(d * sampleRate)
	pcm := p.pcm
	if len(pcm) > n*2 {
		pcm = pcm[len(pcm)-n*2:]
	}
	for i := 0; i+1 < len(pcm); i += 2 {
		left = append(left, float64(pcm[i]))
		right = append(right, float64(pcm[i+1]))
	}
	return
}

// goertzel measures how much of one frequency is in a signal.
func goertzel(x []float64, freq float64) float64 {
	w := 2 * math.Pi * freq / sampleRate
	c := 2 * math.Cos(w)
	var s1, s2 float64
	for _, v := range x {
		s1, s2 = v+c*s1-s2, s1
	}
	return math.Sqrt(s1*s1+s2*s2-c*s1*s2) / float64(len(x))
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func checkChord(t *testing.T, p *fakePhone) {
	t.Helper()
	left, right := p.lastSeconds(1.5)
	if len(left) < sampleRate {
		t.Fatalf("only %d samples decoded", len(left))
	}
	// The tone is an A-major chord: C♯ (554 Hz) on the left, E (659 Hz) on the right.
	l554, l659 := goertzel(left, 554.37), goertzel(left, 659.25)
	r554, r659 := goertzel(right, 554.37), goertzel(right, 659.25)
	t.Logf("left 554 Hz %.4f, 659 Hz %.4f; right 554 Hz %.4f, 659 Hz %.4f", l554, l659, r554, r659)
	if l554 < 0.005 || r659 < 0.005 {
		t.Fatal("chord missing: phone hears silence or noise")
	}
	if l554 < 10*l659 || r659 < 10*r554 {
		t.Fatal("left and right are mixed up or swapped")
	}
}

func TestPhoneHearsTheToneAndSurvivesStreamDrop(t *testing.T) {
	if testing.Short() {
		t.Skip("plays audio for a few seconds")
	}
	settings := defaultSettings
	engine, _, mux, err := newStation(settings, "")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	engine.Start(KindTone, true)
	defer engine.Stop()

	msgs, cancel := listen(t, srv.URL, "")
	welcome := waitFor(t, msgs, "welcome")
	if welcome.EventID != welcome.ID {
		t.Fatalf("event id %q should be the phone id %q", welcome.EventID, welcome.ID)
	}
	id := welcome.ID

	phone := newFakePhone(t)
	postSignal(t, srv.URL, map[string]any{"from": id, "type": "join"})
	offer := waitFor(t, msgs, "offer")
	if !strings.Contains(offer.SDP, "stereo=1") {
		t.Fatal("offer doesn't ask for stereo")
	}
	postSignal(t, srv.URL, map[string]any{"from": id, "type": "answer", "sdp": phone.answer(t, offer.SDP)})

	eventually(t, "the phone to connect", func() bool { return engine.bc.connected() == 1 })
	eventually(t, "two seconds of audio", func() bool {
		phone.mu.Lock()
		defer phone.mu.Unlock()
		return len(phone.pcm) >= 2*sampleRate*channels
	})
	checkChord(t, phone)

	// Off air: phones get silence, not a gap.
	engine.SetLive(false)
	before := phone.packets.Load()
	time.Sleep(700 * time.Millisecond)
	if phone.packets.Load()-before < 20 {
		t.Fatal("stream stopped while off air; it should carry silence")
	}
	if left, _ := phone.lastSeconds(0.3); goertzel(left, 554.37) > 0.001 {
		t.Fatal("phone still hears the tone while off air")
	}
	engine.SetLive(true)

	// Chrome goes to the background on Android: the event stream drops,
	// the audio carries on.
	cancel()
	before = phone.packets.Load()
	time.Sleep(time.Second)
	if got := phone.packets.Load() - before; got < 30 {
		t.Fatalf("only %d packets in the second after the stream dropped", got)
	}
	checkChord(t, phone)
	if engine.hub.Count() != 1 || !engine.bc.Active(id) {
		t.Fatal("phone forgotten while its audio is still playing")
	}

	// Back in the foreground: the browser resumes with its id.
	msgs, cancel = listen(t, srv.URL, id)
	defer cancel()
	if again := waitFor(t, msgs, "welcome"); again.ID != id {
		t.Fatalf("resumed as %q, want %q", again.ID, id)
	}
	if engine.bc.connected() != 1 {
		t.Fatal("audio connection lost across the resume")
	}

	// The DJ's flash reaches the resumed stream.
	engine.Flash("#ff00aa")
	if f := waitFor(t, msgs, "flash"); f.Color != "#ff00aa" {
		t.Fatalf("flash color %q", f.Color)
	}
}
