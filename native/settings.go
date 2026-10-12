package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Settings survive restarts: ~/Library/Application Support/Silent Disco/settings.json.
type Settings struct {
	Name        string `json:"name"`
	Kbps        int    `json:"kbps"`
	Source      string `json:"source,omitempty"`      // last source the DJ picked
	SourceLabel string `json:"sourceLabel,omitempty"` // its name, for "waiting for …"
}

var defaultSettings = Settings{Name: "Silent Disco", Kbps: 192}

func settingsPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Silent Disco", "settings.json")
}

func loadSettings(path string) Settings {
	s := defaultSettings
	if path == "" {
		return s
	}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &s)
	}
	if s.Name == "" {
		s.Name = defaultSettings.Name
	}
	s.Kbps = clampKbps(s.Kbps)
	return s
}

func saveSettings(path string, s Settings) {
	if path == "" {
		return
	}
	os.MkdirAll(filepath.Dir(path), 0o755)
	data, _ := json.MarshalIndent(s, "", "  ")
	os.WriteFile(path, data, 0o644)
}

func clampKbps(k int) int {
	switch {
	case k == 0:
		return defaultSettings.Kbps
	case k < 64:
		return 64
	case k > 256:
		return 256
	}
	return k
}
