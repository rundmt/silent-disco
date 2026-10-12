package main

// Signaling hub: the same protocol server.js speaks, so the existing phone
// page works unchanged. Phones hold a Server-Sent Events stream for messages
// from us and POST /signal for messages to us. The "host" is this process.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

type Meta struct {
	Name string `json:"name"`
	Live bool   `json:"live"`
}

type client struct {
	id  string
	out chan []byte
}

// Hub tracks connected phones and routes their signaling messages.
type Hub struct {
	mu      sync.Mutex
	clients map[string]*client
	meta    Meta

	OnJoin      func(id string)
	OnLeave     func(id string)
	OnAnswer    func(id, sdp string)
	OnCandidate func(id string, candidate json.RawMessage)
}

func NewHub(meta Meta) *Hub {
	return &Hub{clients: map[string]*client{}, meta: meta}
}

func newID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Send queues a message for one phone. Never blocks: a phone that can't keep
// up loses messages rather than stalling everyone else.
func (h *Hub) Send(id string, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.Lock()
	c := h.clients[id]
	h.mu.Unlock()
	if c == nil {
		return
	}
	select {
	case c.out <- data:
	default:
		log.Printf("signaling queue full for %s, dropping message", id[:6])
	}
}

func (h *Hub) Broadcast(msg any) {
	h.mu.Lock()
	ids := make([]string, 0, len(h.clients))
	for id := range h.clients {
		ids = append(ids, id)
	}
	h.mu.Unlock()
	for _, id := range ids {
		h.Send(id, msg)
	}
}

func (h *Hub) SetMeta(m Meta) {
	h.mu.Lock()
	h.meta = m
	h.mu.Unlock()
	h.Broadcast(map[string]any{"type": "meta", "meta": m})
}

func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// ServeEvents is GET /events: one long-lived stream per phone.
func (h *Hub) ServeEvents(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("role") == "host" {
		http.Error(w, "The DJ side is built into the Silent Disco app.", http.StatusForbidden)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	c := &client{id: newID(), out: make(chan []byte, 64)}
	h.mu.Lock()
	h.clients[c.id] = c
	meta := h.meta
	h.mu.Unlock()

	fmt.Fprint(w, ": connected\n\n")
	h.Send(c.id, map[string]any{"type": "welcome", "id": c.id, "hostOnline": true, "meta": meta})

	ping := time.NewTicker(15 * time.Second)
	defer func() {
		ping.Stop()
		h.mu.Lock()
		delete(h.clients, c.id)
		h.mu.Unlock()
		if h.OnLeave != nil {
			h.OnLeave(c.id)
		}
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-c.out:
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// ServeSignal is POST /signal: join, answer, candidate and leave from phones.
func (h *Hub) ServeSignal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var msg struct {
		From      string          `json:"from"`
		Type      string          `json:"type"`
		SDP       string          `json:"sdp"`
		Candidate json.RawMessage `json:"candidate"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&msg); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	_, known := h.clients[msg.From]
	h.mu.Unlock()
	if !known {
		http.Error(w, "unknown sender", http.StatusBadRequest)
		return
	}
	switch msg.Type {
	case "join":
		go h.OnJoin(msg.From)
	case "answer":
		h.OnAnswer(msg.From, msg.SDP)
	case "candidate":
		h.OnCandidate(msg.From, msg.Candidate)
	case "leave":
		h.OnLeave(msg.From)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
