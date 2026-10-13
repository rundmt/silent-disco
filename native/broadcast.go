package main

// One shared Opus track, fanned out to every phone over its own WebRTC
// connection. Audio is encoded once no matter how many people listen.

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type peer struct {
	pc        *webrtc.PeerConnection
	mu        sync.Mutex
	remoteSet bool
	pending   []webrtc.ICECandidateInit // candidates that arrived before the answer
}

type Broadcaster struct {
	api   *webrtc.API
	track *webrtc.TrackLocalStaticSample
	hub   *Hub
	kbps  int

	mu    sync.Mutex
	peers map[string]*peer
	// OnChange is called whenever the number of connected phones changes.
	OnChange func(connected int)
}

func opusFmtp(kbps int) string {
	// Full-band stereo music, with forward error correction for Wi-Fi loss.
	return "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=" + itoa(kbps*1000)
}

func NewBroadcaster(hub *Hub, kbps int) (*Broadcaster, error) {
	codec := webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeOpus,
		ClockRate:   48000,
		Channels:    2,
		SDPFmtpLine: opusFmtp(256), // the ceiling; the encoder sets the actual rate
	}

	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: codec, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}
	s := webrtc.SettingEngine{}
	// LAN only: IPv4 host candidates are all we need, no STUN/TURN.
	s.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})

	track, err := webrtc.NewTrackLocalStaticSample(codec, "audio", "silent-disco")
	if err != nil {
		return nil, err
	}
	return &Broadcaster{
		api:   webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(s)),
		track: track,
		hub:   hub,
		kbps:  kbps,
		peers: map[string]*peer{},
	}, nil
}

func (b *Broadcaster) SetKbps(kbps int) {
	b.mu.Lock()
	b.kbps = kbps
	b.mu.Unlock()
}

// WriteFrame sends one encoded 20 ms Opus frame to every connected phone.
func (b *Broadcaster) WriteFrame(frame []byte) {
	if err := b.track.WriteSample(media.Sample{Data: frame, Duration: frameDuration}); err != nil {
		log.Printf("write: %v", err)
	}
}

func (b *Broadcaster) connected() int {
	n := 0
	b.mu.Lock()
	for _, p := range b.peers {
		if p.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			n++
		}
	}
	b.mu.Unlock()
	return n
}

func (b *Broadcaster) changed() {
	if b.OnChange != nil {
		b.OnChange(b.connected())
	}
}

// Join answers a phone's request for the stream with an offer.
func (b *Broadcaster) Join(id string) {
	b.Leave(id) // a rejoin replaces the old connection

	pc, err := b.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		log.Printf("peer: %v", err)
		return
	}
	p := &peer{pc: pc}
	b.mu.Lock()
	b.peers[id] = p
	b.mu.Unlock()

	sender, err := pc.AddTrack(b.track)
	if err != nil {
		log.Printf("add track: %v", err)
		b.Leave(id)
		return
	}
	// Drain RTCP (receiver reports, NACKs) so the interceptors keep working.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			b.removeIf(id, pc)
		}
		b.changed()
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		log.Printf("offer: %v", err)
		b.Leave(id)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		log.Printf("local description: %v", err)
		b.Leave(id)
		return
	}
	// On a LAN, gathering takes milliseconds; sending the complete offer
	// avoids racing candidates against it.
	<-gathered
	b.mu.Lock()
	kbps := b.kbps
	b.mu.Unlock()
	b.hub.Send(id, map[string]any{"type": "offer", "sdp": pc.LocalDescription().SDP, "kbps": kbps})
}

func (b *Broadcaster) Answer(id, sdp string) {
	b.mu.Lock()
	p := b.peers[id]
	b.mu.Unlock()
	if p == nil {
		return
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		log.Printf("answer from %s: %v", id[:6], err)
		return
	}
	p.mu.Lock()
	p.remoteSet = true
	pending := p.pending
	p.pending = nil
	p.mu.Unlock()
	for _, c := range pending {
		p.pc.AddICECandidate(c)
	}
}

func (b *Broadcaster) Candidate(id string, raw json.RawMessage) {
	b.mu.Lock()
	p := b.peers[id]
	b.mu.Unlock()
	if p == nil {
		return
	}
	var c webrtc.ICECandidateInit
	if err := json.Unmarshal(raw, &c); err != nil {
		return
	}
	p.mu.Lock()
	if !p.remoteSet {
		p.pending = append(p.pending, c)
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	if err := p.pc.AddICECandidate(c); err != nil {
		log.Printf("candidate from %s: %v", id[:6], err)
	}
}

func (b *Broadcaster) Leave(id string) {
	b.mu.Lock()
	p := b.peers[id]
	delete(b.peers, id)
	b.mu.Unlock()
	if p != nil {
		p.pc.Close()
		b.changed()
	}
}

// Active reports whether a phone still has a working audio connection.
func (b *Broadcaster) Active(id string) bool {
	b.mu.Lock()
	p := b.peers[id]
	b.mu.Unlock()
	if p == nil {
		return false
	}
	switch p.pc.ConnectionState() {
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
		return false
	}
	return true
}

func (b *Broadcaster) removeIf(id string, pc *webrtc.PeerConnection) {
	b.mu.Lock()
	if p := b.peers[id]; p != nil && p.pc == pc {
		delete(b.peers, id)
	}
	b.mu.Unlock()
}
