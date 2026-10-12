// The app window (the DJ console in a WKWebView) and the menu bar icon.
#pragma once

// Runs the Cocoa app on the main thread, showing url. Never returns.
void sd_app_run(const char *url);

// Updates the menu bar menu: a status line, and Go live / Stop broadcast.
void sd_app_set_status(const char *text, int live);
