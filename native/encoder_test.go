package main

import (
	"math"
	"testing"
)

// 44.1 kHz input (a common Mac output rate) must come out at 48 kHz with no
// clicks at chunk boundaries.
func TestResampler44k(t *testing.T) {
	var r resampler
	const in = 44100
	var out []float32
	n := 0
	for chunk := 0; chunk < 100; chunk++ { // 1 s in 10 ms-ish chunks of 441 frames
		buf := make([]float32, 441*2)
		for i := 0; i < 441; i++ {
			v := float32(math.Sin(2 * math.Pi * 1000 * float64(n) / in))
			buf[2*i], buf[2*i+1] = v, v
			n++
		}
		out = append(out, r.process(buf, in)...)
	}
	frames := len(out) / 2
	if frames < 47950 || frames > 48050 {
		t.Fatalf("got %d frames for 1 s, want ~48000", frames)
	}
	// A 1 kHz sine at 48 kHz moves at most 2π·1000/48000 ≈ 0.131 per sample.
	for i := 1; i < frames; i++ {
		if d := math.Abs(float64(out[2*i] - out[2*i-2])); d > 0.14 {
			t.Fatalf("discontinuity of %.3f at frame %d", d, i)
		}
	}
}
