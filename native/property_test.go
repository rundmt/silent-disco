package main

// Property tests: instead of a few hand-picked examples, rapid generates
// thousands of inputs and checks rules that must hold for all of them,
// shrinking any failure to the smallest input that breaks a rule.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"pgregory.net/rapid"
)

// stereo draws interleaved stereo samples in -1..1.
func stereo(t *rapid.T, label string, maxFrames int) []float32 {
	frames := rapid.IntRange(0, maxFrames).Draw(t, label+" frames")
	out := make([]float32, frames*2)
	for i := range out {
		out[i] = rapid.Float32Range(-1, 1).Draw(t, label)
	}
	return out
}

// chunks splits interleaved stereo at random frame boundaries.
func chunks(t *rapid.T, in []float32) [][]float32 {
	var out [][]float32
	for len(in) > 0 {
		n := 2 * rapid.IntRange(0, len(in)/2).Draw(t, "chunk frames")
		out = append(out, in[:n])
		in = in[n:]
	}
	return out
}

var captureRates = []int{8000, 16000, 22050, 32000, 44100, 88200, 96000}

func TestResamplerProperties(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		rate := rapid.SampledFrom(captureRates).Draw(t, "rate")
		in := stereo(t, "sample", 600)
		frames := len(in) / 2

		var whole resampler
		out := whole.process(in, rate)

		// Length: (frames-1) intervals of input become that many seconds at 48 kHz.
		if frames > 1 {
			want := float64(frames-1) * sampleRate / float64(rate)
			if got := float64(len(out) / 2); math.Abs(got-want) > 1.01 {
				t.Fatalf("%d frames at %d Hz gave %v frames, want about %.1f", frames, rate, got, want)
			}
		}
		// No overshoot: linear interpolation stays within the input's range.
		for ch := 0; ch < 2; ch++ {
			lo, hi := float32(math.Inf(1)), float32(math.Inf(-1))
			for i := ch; i < len(in); i += 2 {
				lo, hi = min(lo, in[i]), max(hi, in[i])
			}
			for i := ch; i < len(out); i += 2 {
				if out[i] < lo-1e-6 || out[i] > hi+1e-6 {
					t.Fatalf("channel %d sample %v outside input range [%v, %v]", ch, out[i], lo, hi)
				}
			}
		}
		// Chunking doesn't matter: Core Audio hands over buffers of any size,
		// and the result must sound the same as one long buffer.
		var parts resampler
		var joined []float32
		for _, c := range chunks(t, in) {
			joined = append(joined, parts.process(c, rate)...)
		}
		if d := len(joined) - len(out); d < -2 || d > 2 {
			t.Fatalf("chunked gave %d samples, whole gave %d", len(joined), len(out))
		}
		for i := range min(len(joined), len(out)) {
			if math.Abs(float64(joined[i]-out[i])) > 1e-3 {
				t.Fatalf("sample %d: chunked %v, whole %v", i, joined[i], out[i])
			}
		}
	})
}

func TestResamplerKeepsSteadyLevel(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		rate := rapid.SampledFrom(captureRates).Draw(t, "rate")
		l, r := rapid.Float32Range(-1, 1).Draw(t, "left"), rapid.Float32Range(-1, 1).Draw(t, "right")
		in := make([]float32, 2*rapid.IntRange(0, 500).Draw(t, "frames"))
		for i := 0; i < len(in); i += 2 {
			in[i], in[i+1] = l, r
		}
		var rs resampler
		for _, c := range chunks(t, in) {
			out := rs.process(c, rate)
			for i := 0; i < len(out); i += 2 {
				if math.Abs(float64(out[i]-l)) > 1e-6 || math.Abs(float64(out[i+1]-r)) > 1e-6 {
					t.Fatalf("steady (%v, %v) came out as (%v, %v)", l, r, out[i], out[i+1])
				}
			}
		}
	})
}

func TestEncoderFrameCount(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		frames := 0
		enc, err := NewEncoder(192, func([]byte) { frames++ })
		if err != nil {
			t.Fatal(err)
		}
		enc.SetMuted(rapid.Bool().Draw(t, "muted"))
		in := stereo(t, "sample", 5000)
		var peak float32
		for _, s := range in {
			peak = max(peak, float32(math.Abs(float64(s))))
		}
		for _, c := range chunks(t, in) {
			enc.Push(c, sampleRate)
		}
		// Every full 20 ms of audio becomes exactly one Opus frame, muted or not.
		if want := len(in) / (frameSamples * channels); frames != want {
			t.Fatalf("%d samples made %d frames, want %d", len(in), frames, want)
		}
		// The meter shows the real level even off air.
		if got := enc.Peak(); got != peak {
			t.Fatalf("peak %v, want %v", got, peak)
		}
		if enc.Peak() != 0 {
			t.Fatal("reading the peak should reset it")
		}
	})
}

func TestGroupAppsProperties(t *testing.T) {
	apps := []string{"", "/Applications/djay Pro.app", "/Applications/rekordbox.app", "/Applications/Spotify.app", "/Applications/Google Chrome.app"}
	names := []string{"djay Pro", "rekordbox", "Spotify", "Google Chrome Helper", "coreaudiod", "Serato DJ Pro", "zoom"}
	rapid.Check(t, func(t *rapid.T) {
		n := rapid.IntRange(0, 25).Draw(t, "processes")
		procs := make([]audioProcess, n)
		for i := range procs {
			procs[i] = audioProcess{
				pid:     1000 + i,
				playing: rapid.Bool().Draw(t, "playing"),
				appPath: rapid.SampledFrom(apps).Draw(t, "app"),
				name:    rapid.SampledFrom(names).Draw(t, "name"),
			}
		}
		out := groupApps(procs)

		seen := map[int]string{}
		ids := map[string]bool{}
		for _, s := range out {
			if ids[s.ID] {
				t.Fatalf("%s listed twice", s.ID)
			}
			ids[s.ID] = true
			if !slices.IsSorted(s.pids) || len(s.pids) == 0 {
				t.Fatalf("%s has pids %v", s.ID, s.pids)
			}
			for _, pid := range s.pids {
				if other, dup := seen[pid]; dup {
					t.Fatalf("pid %d in both %s and %s", pid, other, s.ID)
				}
				seen[pid] = s.ID
			}
		}
		for _, p := range procs {
			id, listed := seen[p.pid]
			// Every process of a real app is tapped with its app. Bare
			// processes only show up while making sound (or if they're DJ software).
			mustList := p.appPath != "" || p.playing || isDJApp(p.name, "", "")
			if mustList && !listed {
				t.Fatalf("pid %d (%s, %s) missing", p.pid, p.name, p.appPath)
			}
			if listed {
				s, _ := findSource(out, id)
				if p.playing && !s.Playing {
					t.Fatalf("%s has a playing process but isn't marked playing", s.ID)
				}
			}
		}
		// DJ software first, then whatever is playing, then the rest.
		rank := func(s SourceInfo) int {
			return map[[2]bool]int{{true, true}: 0, {true, false}: 1, {false, true}: 2, {false, false}: 3}[[2]bool{s.DJ, s.Playing}]
		}
		if !slices.IsSortedFunc(out, func(a, b SourceInfo) int { return rank(a) - rank(b) }) {
			t.Fatalf("out of order: %v", ids)
		}
		// The automatic pick is the best DJ app, if there is one.
		if dj, ok := bestDJApp(out); ok && (!dj.DJ || slices.ContainsFunc(out, func(s SourceInfo) bool { return s.DJ && s.Playing && !dj.Playing })) {
			t.Fatalf("auto-picked %s over a playing DJ app", dj.ID)
		}
	})
}

func TestClampKbps(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		k := rapid.Int().Draw(t, "kbps")
		c := clampKbps(k)
		switch {
		case c < 64 || c > 256:
			t.Fatalf("clampKbps(%d) = %d", k, c)
		case clampKbps(c) != c:
			t.Fatalf("clampKbps not idempotent at %d", k)
		case k >= 64 && k <= 256 && c != k:
			t.Fatalf("clampKbps changed in-range %d to %d", k, c)
		case k == 0 && c != 192:
			t.Fatalf("missing bitrate should mean 192, got %d", c)
		}
	})
}

var visualGen = rapid.Custom(func(t *rapid.T) Visual {
	return Visual{
		Style:   rapid.SampledFrom([]string{"ring", "bars", "wave", "off", "", "Ring", "spiral"}).Draw(t, "style"),
		Palette: rapid.SampledFrom([]string{"neon", "sunset", "ocean", "mono", "", "rainbow"}).Draw(t, "palette"),
	}
})

func TestSettingsRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		path := filepath.Join(os.TempDir(), "sd-settings-prop", rapid.StringMatching(`[a-z]{8}`).Draw(t, "file")+".json")
		defer os.Remove(path)
		s := Settings{
			Name:        rapid.StringN(1, 60, -1).Draw(t, "name"),
			Kbps:        rapid.IntRange(64, 256).Draw(t, "kbps"),
			Source:      rapid.String().Draw(t, "source"),
			SourceLabel: rapid.String().Draw(t, "label"),
			Visual:      visualGen.Draw(t, "visual"),
		}
		if !s.Visual.valid() {
			s.Visual = defaultVisual
		}
		saveSettings(path, s)
		got := loadSettings(path)
		// Strings that aren't valid UTF-8 come back with replacement characters, like any JSON.
		want := s
		for _, p := range []*string{&want.Name, &want.Source, &want.SourceLabel} {
			b, _ := json.Marshal(*p)
			json.Unmarshal(b, p)
		}
		if got != want {
			t.Fatalf("saved %+v, loaded %+v", want, got)
		}
	})
}

func TestLoadSettingsAlwaysSane(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		path := filepath.Join(os.TempDir(), "sd-settings-prop", "junk.json")
		os.MkdirAll(filepath.Dir(path), 0o755)
		defer os.Remove(path)
		var data []byte
		if rapid.Bool().Draw(t, "json-shaped") {
			raw := map[string]any{
				"name":   rapid.SampledFrom([]any{"", "Party", 5, nil}).Draw(t, "name"),
				"kbps":   rapid.SampledFrom([]any{0, -5, 64, 999, "fast", 1e12}).Draw(t, "kbps"),
				"visual": visualGen.Draw(t, "visual"),
			}
			data, _ = json.Marshal(raw)
		} else {
			data = rapid.SliceOf(rapid.Byte()).Draw(t, "bytes")
		}
		os.WriteFile(path, data, 0o644)
		// Whatever is on disk, the app starts with something usable.
		s := loadSettings(path)
		if s.Name == "" || s.Kbps < 64 || s.Kbps > 256 || !s.Visual.valid() {
			t.Fatalf("%q loaded as %+v", data, s)
		}
	})
}

// TestHubResumeModel checks the hub against a model of phones whose event
// streams drop and come back in any order, as Android does.
func TestHubResumeModel(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		hub := NewHub(Meta{})
		active := map[string]bool{} // phone id -> audio connection up
		left := map[string]int{}
		hub.OnActive = func(id string) bool { return active[id] }
		hub.OnLeave = func(id string) { left[id]++ }

		type stream struct {
			c    *client
			stop chan struct{}
		}
		var streams []stream       // every stream ever opened, live or stale
		known := map[string]bool{} // ids the model expects the hub to hold
		var everID []string

		check := func(step string) {
			if hub.Count() != len(known) {
				t.Fatalf("%s: hub has %d phones, model %d", step, hub.Count(), len(known))
			}
			for id := range known {
				if hub.clients[id] == nil {
					t.Fatalf("%s: %s forgotten", step, id)
				}
			}
			for id, n := range left {
				if n > 1 || known[id] {
					t.Fatalf("%s: %s left %d times (still known %v)", step, id, n, known[id])
				}
			}
		}

		t.Repeat(map[string]func(*rapid.T){
			"a new phone joins": func(t *rapid.T) {
				c, stop := hub.attach("")
				if known[c.id] || slices.Contains(everID, c.id) {
					t.Fatalf("new phone reused id %s", c.id)
				}
				known[c.id], active[c.id] = true, true
				everID = append(everID, c.id)
				streams = append(streams, stream{c, stop})
				check("join")
			},
			"a phone reconnects with its id": func(t *rapid.T) {
				if len(everID) == 0 {
					t.Skip("no phones yet")
				}
				id := rapid.SampledFrom(everID).Draw(t, "phone")
				var oldStop chan struct{}
				if old := hub.clients[id]; old != nil && old.attached {
					oldStop = old.stop
				}
				c, stop := hub.attach(id)
				if known[id] != (c.id == id) {
					t.Fatalf("reconnect as %s: got %s (still known %v)", id, c.id, known[id])
				}
				if c.id != id {
					known[c.id], active[c.id] = true, true
					everID = append(everID, c.id)
				}
				// Only the newest stream for a phone is live.
				if oldStop != nil {
					select {
					case <-oldStop:
					default:
						t.Fatal("older stream not told to stop")
					}
				}
				streams = append(streams, stream{c, stop})
				check("reconnect")
			},
			"a stream drops": func(t *rapid.T) {
				if len(streams) == 0 {
					t.Skip("no streams")
				}
				s := rapid.SampledFrom(streams).Draw(t, "stream")
				wasLive := hub.clients[s.c.id] == s.c && s.c.stop == s.stop && s.c.attached
				hub.detach(s.c, s.stop)
				if wasLive && s.c.attached {
					t.Fatal("live stream dropped but phone still attached")
				}
				if s.c.linger != nil {
					s.c.linger.Stop() // the test fires checks itself
				}
				check("drop")
			},
			"audio connects or drops": func(t *rapid.T) {
				if len(everID) == 0 {
					t.Skip("no phones yet")
				}
				id := rapid.SampledFrom(everID).Draw(t, "phone")
				active[id] = !active[id]
			},
			"the linger check runs": func(t *rapid.T) {
				if len(streams) == 0 {
					t.Skip("no streams")
				}
				s := rapid.SampledFrom(streams).Draw(t, "stream")
				// Forgotten exactly when nothing is listening: no stream and no audio.
				forget := known[s.c.id] && hub.clients[s.c.id] == s.c && !s.c.attached && !active[s.c.id]
				hub.checkDetached(s.c)
				if s.c.linger != nil {
					s.c.linger.Stop()
				}
				if forget {
					delete(known, s.c.id)
				}
				check("linger")
			},
		})
	})
}
