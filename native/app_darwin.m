#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include "app_darwin.h"
#include "_cgo_export.h"

@interface SDApp : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate>
@property(strong) NSString *url;
@property(strong) NSWindow *window;
@property(strong) WKWebView *web;
@property(strong) NSStatusItem *statusItem;
@property(strong) NSMenuItem *infoItem;
@property(strong) NSMenuItem *liveItem;
@property BOOL live;
@end

static SDApp *gApp;
static id gActivity;

@implementation SDApp

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    [self buildMainMenu];
    [self buildStatusItem];
    [self buildWindow];
    [self show:nil];
}

- (void)addMenu:(NSMenu *)menu to:(NSMenu *)bar {
    NSMenuItem *item = [NSMenuItem new];
    item.submenu = menu;
    [bar addItem:item];
}

- (void)buildMainMenu {
    NSMenu *bar = [NSMenu new];

    NSMenu *app = [NSMenu new];
    [app addItemWithTitle:@"About Silent Disco" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [app addItem:[NSMenuItem separatorItem]];
    [app addItemWithTitle:@"Hide Silent Disco" action:@selector(hide:) keyEquivalent:@"h"];
    [app addItemWithTitle:@"Quit Silent Disco" action:@selector(terminate:) keyEquivalent:@"q"];
    [self addMenu:app to:bar];

    // Without an Edit menu, copy and paste don't work in the web view.
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
    [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
    [edit addItem:[NSMenuItem separatorItem]];
    [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [self addMenu:edit to:bar];

    NSMenu *win = [[NSMenu alloc] initWithTitle:@"Window"];
    [win addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [win addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
    [self addMenu:win to:bar];

    NSApp.mainMenu = bar;
    NSApp.windowsMenu = win;
}

- (void)buildStatusItem {
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSImage *icon = [NSImage imageWithSystemSymbolName:@"headphones" accessibilityDescription:@"Silent Disco"];
    icon.template = YES;
    self.statusItem.button.image = icon;

    NSMenu *menu = [NSMenu new];
    menu.autoenablesItems = NO;
    self.infoItem = [menu addItemWithTitle:@"Off air" action:nil keyEquivalent:@""];
    self.infoItem.enabled = NO;
    [menu addItem:[NSMenuItem separatorItem]];
    self.liveItem = [menu addItemWithTitle:@"Go live" action:@selector(toggleLive:) keyEquivalent:@""];
    self.liveItem.target = self;
    NSMenuItem *open = [menu addItemWithTitle:@"Open Silent Disco" action:@selector(show:) keyEquivalent:@""];
    open.target = self;
    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItemWithTitle:@"Quit Silent Disco" action:@selector(terminate:) keyEquivalent:@""];
    self.statusItem.menu = menu;
}

- (void)buildWindow {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 940, 680)
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"Silent Disco";
    self.window.minSize = NSMakeSize(720, 560);
    self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    self.window.backgroundColor = [NSColor colorWithSRGBRed:0x0b / 255.0 green:0x0b / 255.0 blue:0x12 / 255.0 alpha:1];
    self.window.releasedWhenClosed = NO;
    self.window.delegate = self;
    [self.window center];
    [self.window setFrameAutosaveName:@"SilentDiscoConsole"];

    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    self.web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self;
    self.web.UIDelegate = self;
    [self.web setValue:@NO forKey:@"drawsBackground"]; // no white flash while loading
    if (@available(macOS 13.3, *)) self.web.inspectable = YES;
    [self.window.contentView addSubview:self.web];
    [self.web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:self.url]]];
}

- (void)show:(id)sender {
    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
}

- (void)toggleLive:(id)sender {
    goToggleLive();
}

// Closing the window keeps the party going; the menu bar icon brings it back.
- (BOOL)windowShouldClose:(NSWindow *)sender {
    [sender orderOut:nil];
    return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)visible {
    [self show:nil];
    return NO;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)app {
    if (!self.live) return NSTerminateNow;
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Stop the party?";
    alert.informativeText = @"You're live. Quitting stops the audio for everyone listening.";
    [alert addButtonWithTitle:@"Quit"];
    [alert addButtonWithTitle:@"Cancel"];
    [NSApp activateIgnoringOtherApps:YES];
    return [alert runModal] == NSAlertFirstButtonReturn ? NSTerminateNow : NSTerminateCancel;
}

- (void)applicationWillTerminate:(NSNotification *)note {
    goWillQuit();
}

// Links that leave the console (help pages, the listener link) open in the browser.
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *u = action.request.URL;
    if ([u.host isEqualToString:@"127.0.0.1"] && [u.path isEqualToString:@"/console.html"]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    [[NSWorkspace sharedWorkspace] openURL:u];
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)config
       forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    if (action.request.URL) [[NSWorkspace sharedWorkspace] openURL:action.request.URL];
    return nil;
}

@end

void sd_app_run(const char *url) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        gApp = [SDApp new];
        gApp.url = [NSString stringWithUTF8String:url];
        NSApp.delegate = gApp;
        // A GUI app gets App Nap: when its window is hidden or covered, macOS
        // throttles its timers and threads. Terminal programs don't. For live
        // audio that throttling makes packets bunch up and phones add delay.
        gActivity = [[NSProcessInfo processInfo]
            beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
                              reason:@"Streaming live audio"];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp run];
    }
}

void sd_app_set_status(const char *text, int live) {
    NSString *t = [NSString stringWithUTF8String:text];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!gApp.statusItem) return;
        gApp.live = live != 0;
        gApp.infoItem.title = t;
        gApp.liveItem.title = live ? @"Stop broadcast" : @"Go live";
        gApp.statusItem.button.contentTintColor = live ? [NSColor systemRedColor] : nil;
    });
}
