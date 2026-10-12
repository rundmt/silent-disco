//go:build !darwin

package main

const windowSupported = false

func runWindow(*Engine, string) {}

func setMenuStatus(string, bool) {}
