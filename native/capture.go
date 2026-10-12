package main

import (
	"math"
	"time"
)

// AudioFunc receives interleaved stereo float32 samples and their sample rate.
type AudioFunc func(samples []float32, rate int)

// Source is a running capture: a Core Audio tap or input on macOS, or a test
// tone anywhere.
type Source interface {
	Start(onAudio AudioFunc) error
	Stop()
}

// ToneSource plays a gentle repeating chord so the pipeline can be tested
// without any capture permissions.
type ToneSource struct{ stop chan struct{} }

func (t *ToneSource) Start(onAudio AudioFunc) error {
	t.stop = make(chan struct{})
	go func() {
		const chunk = 480 // 10 ms
		tick := time.NewTicker(10 * time.Millisecond)
		defer tick.Stop()
		n := 0
		buf := make([]float32, chunk*2)
		for {
			select {
			case <-t.stop:
				return
			case <-tick.C:
			}
			for i := 0; i < chunk; i++ {
				tm := float64(n) / sampleRate
				// A pulsing A-major chord, with left and right slightly different.
				env := 0.5 + 0.5*math.Sin(2*math.Pi*0.5*tm)
				l := math.Sin(2*math.Pi*440*tm) + 0.6*math.Sin(2*math.Pi*554.37*tm)
				r := math.Sin(2*math.Pi*440*tm) + 0.6*math.Sin(2*math.Pi*659.25*tm)
				buf[2*i] = float32(0.2 * env * l)
				buf[2*i+1] = float32(0.2 * env * r)
				n++
			}
			onAudio(buf, sampleRate)
		}
	}()
	return nil
}

func (t *ToneSource) Stop() { close(t.stop) }
