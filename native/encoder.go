package main

// Turns captured PCM (any sample rate) into 20 ms stereo Opus frames.

import (
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"gopkg.in/hraban/opus.v2"
)

const (
	sampleRate    = 48000
	channels      = 2
	frameSamples  = 960 // 20 ms at 48 kHz, per channel
	frameDuration = 20 * time.Millisecond
)

func itoa(n int) string { return strconv.Itoa(n) }

type Encoder struct {
	enc    *opus.Encoder
	out    func(frame []byte)
	pcm    []float32 // interleaved stereo at 48 kHz, waiting to fill a frame
	packet []byte
	rs     resampler
	encMu  sync.Mutex  // the Opus encoder is used by Push and SetBitrate
	muted  atomic.Bool // encode silence (off air) but keep metering

	mu   sync.Mutex
	peak float32 // loudest sample since last read, for the level meter
}

func NewEncoder(kbps int, out func([]byte)) (*Encoder, error) {
	enc, err := opus.NewEncoder(sampleRate, channels, opus.AppAudio)
	if err != nil {
		return nil, err
	}
	enc.SetBitrate(kbps * 1000)
	enc.SetComplexity(8)
	enc.SetInBandFEC(true)
	enc.SetPacketLossPerc(5)
	return &Encoder{enc: enc, out: out, packet: make([]byte, 4000)}, nil
}

// Push accepts interleaved stereo float32 samples at the given rate.
func (e *Encoder) Push(samples []float32, rate int) {
	if rate != sampleRate {
		samples = e.rs.process(samples, rate)
	}
	var peak float32
	for _, s := range samples {
		if a := float32(math.Abs(float64(s))); a > peak {
			peak = a
		}
	}
	e.mu.Lock()
	if peak > e.peak {
		e.peak = peak
	}
	e.mu.Unlock()

	if e.muted.Load() {
		samples = make([]float32, len(samples))
	}
	e.encMu.Lock()
	defer e.encMu.Unlock()
	e.pcm = append(e.pcm, samples...)
	for len(e.pcm) >= frameSamples*channels {
		n, err := e.enc.EncodeFloat32(e.pcm[:frameSamples*channels], e.packet)
		if err == nil {
			frame := make([]byte, n)
			copy(frame, e.packet[:n])
			e.out(frame)
		}
		e.pcm = e.pcm[frameSamples*channels:]
	}
}

// SetMuted makes the encoder send silence instead of the audio it's given.
func (e *Encoder) SetMuted(m bool) { e.muted.Store(m) }

func (e *Encoder) SetBitrate(kbps int) {
	e.encMu.Lock()
	e.enc.SetBitrate(kbps * 1000)
	e.encMu.Unlock()
}

// Peak returns and resets the loudest sample level (0..1).
func (e *Encoder) Peak() float32 {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := e.peak
	e.peak = 0
	return p
}

// resampler converts interleaved stereo to 48 kHz by linear interpolation.
// Fine for a prototype; a proper polyphase filter would sound cleaner when
// the Mac runs at 44.1 kHz.
type resampler struct {
	pos  float64    // fractional read position into the current input
	last [2]float32 // final frame of the previous chunk
	have bool
}

func (r *resampler) process(in []float32, rate int) []float32 {
	step := float64(rate) / sampleRate
	frames := len(in) / 2
	if frames == 0 {
		return nil // nothing to read, and no frame to remember
	}
	at := func(i int) (float32, float32) {
		if i < 0 {
			return r.last[0], r.last[1]
		}
		return in[2*i], in[2*i+1]
	}
	if !r.have {
		r.pos = 0
		r.have = true
		r.last[0], r.last[1] = at(0)
	}
	out := make([]float32, 0, int(float64(frames)/step)*2+4)
	// Positions are relative to this chunk; -1 refers to the previous chunk's last frame.
	for r.pos < float64(frames-1) {
		i := int(math.Floor(r.pos))
		f := float32(r.pos - float64(i))
		l0, r0 := at(i)
		l1, r1 := at(i + 1)
		out = append(out, l0+(l1-l0)*f, r0+(r1-r0)*f)
		r.pos += step
	}
	r.pos -= float64(frames)
	if frames > 0 {
		r.last[0], r.last[1] = at(frames - 1)
	}
	return out
}
