//go:build !darwin

package main

import "errors"

// Only the test tone works off macOS for now.

func openSource(s SourceInfo) (Source, error) {
	if s.Kind == KindTone {
		return &ToneSource{}, nil
	}
	return nil, errors.New("capturing audio is only supported on macOS so far")
}

func listSources() []SourceInfo { return []SourceInfo{toneSource} }

func appIcon(string) ([]byte, bool) { return nil, false }

func openPrivacySettings(string) {}
