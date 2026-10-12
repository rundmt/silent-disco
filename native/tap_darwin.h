// Audio capture on macOS without a virtual audio driver:
//  * Core Audio process taps record what other apps play (macOS 14.2+).
//  * Input devices (an audio interface, a mixer's USB out, BlackHole) are
//    read directly from the hardware.
#pragma once

// Starts a process tap on the given pids, or on all system audio when n is 0.
// Returns 0 on success, otherwise writes a message to err.
int sd_tap_start(const int *pids, int n, char *err, int errLen);

// Starts reading channels 1–2 of the input device with this UID.
int sd_input_start(const char *uid, char *err, int errLen);

// Stops whichever capture is running. Safe to call when nothing is.
void sd_capture_stop(void);

// Processes Core Audio knows about, one per line:
// "<pid>\t<1 if playing now>\t<app bundle path or empty>\t<display name>\t<bundle id>".
// Helper processes report the app that contains them. Caller frees.
char *sd_list_processes(void);

// Input devices, one per line: "<uid>\t<name>\t<input channels>". Caller frees.
char *sd_list_inputs(void);

// The app's icon as PNG, size x size pixels. Returns NULL if unavailable;
// otherwise the caller frees the bytes.
void *sd_app_icon_png(const char *appPath, int size, int *len);

// Microphone permission (needed for input devices): 0 not asked yet,
// 1 denied, 2 allowed. sd_mic_request asks if needed and waits for the answer.
int sd_mic_status(void);
int sd_mic_request(void);
