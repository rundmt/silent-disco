#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <libproc.h>
#include <unistd.h>
#include "tap_darwin.h"
#include "_cgo_export.h"

// The capture that's running, if any. A tap reads through a private
// aggregate device; an input reads straight from the device.
static AudioObjectID gTap = kAudioObjectUnknown;
static AudioObjectID gAggregate = kAudioObjectUnknown;
static AudioObjectID gDevice = kAudioObjectUnknown;
static AudioDeviceIOProcID gProc = NULL;
static float *gScratch = NULL;
static UInt32 gScratchFrames = 0;

static void setErr(char *err, int len, NSString *msg) {
    if (err && len > 0) snprintf(err, len, "%s", msg.UTF8String);
}

static NSString *statusText(OSStatus st) {
    UInt32 be = CFSwapInt32HostToBig((UInt32)st);
    char c[5] = {0};
    memcpy(c, &be, 4);
    BOOL printable = YES;
    for (int i = 0; i < 4; i++) if (c[i] < 32 || c[i] > 126) printable = NO;
    return printable ? [NSString stringWithFormat:@"'%s' (%d)", c, (int)st] : [NSString stringWithFormat:@"%d", (int)st];
}

static AudioObjectPropertyAddress addr(AudioObjectPropertySelector sel) {
    AudioObjectPropertyAddress a = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    return a;
}

static NSArray<NSNumber *> *objectList(AudioObjectID owner, AudioObjectPropertySelector sel) {
    AudioObjectPropertyAddress a = addr(sel);
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(owner, &a, 0, NULL, &size) != noErr || size == 0) return @[];
    UInt32 count = size / sizeof(AudioObjectID);
    AudioObjectID *ids = malloc(size);
    NSMutableArray *out = [NSMutableArray array];
    if (AudioObjectGetPropertyData(owner, &a, 0, NULL, &size, ids) == noErr) {
        for (UInt32 i = 0; i < count; i++) [out addObject:@(ids[i])];
    }
    free(ids);
    return out;
}

static NSString *stringProp(AudioObjectID obj, AudioObjectPropertySelector sel) {
    AudioObjectPropertyAddress a = addr(sel);
    CFStringRef s = NULL;
    UInt32 size = sizeof(s);
    if (AudioObjectGetPropertyData(obj, &a, 0, NULL, &size, &s) != noErr || !s) return @"";
    return (__bridge_transfer NSString *)s;
}

// --- Processes ---------------------------------------------------------------

static pid_t processPID(AudioObjectID obj) {
    AudioObjectPropertyAddress a = addr(kAudioProcessPropertyPID);
    pid_t pid = -1;
    UInt32 size = sizeof(pid);
    AudioObjectGetPropertyData(obj, &a, 0, NULL, &size, &pid);
    return pid;
}

static BOOL processIsPlaying(AudioObjectID obj) {
    AudioObjectPropertyAddress a = addr(kAudioProcessPropertyIsRunningOutput);
    UInt32 v = 0, size = sizeof(v);
    AudioObjectGetPropertyData(obj, &a, 0, NULL, &size, &v);
    return v != 0;
}

static AudioObjectID processObject(pid_t pid) {
    AudioObjectPropertyAddress a = addr(kAudioHardwarePropertyTranslatePIDToProcessObject);
    AudioObjectID obj = kAudioObjectUnknown;
    UInt32 size = sizeof(obj);
    AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof(pid), &pid, &size, &obj);
    return obj;
}

static NSString *clean(NSString *s) {
    s = [s stringByReplacingOccurrencesOfString:@"\t" withString:@" "];
    return [s stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
}

char *sd_list_processes(void) {
    @autoreleasepool {
        NSMutableString *out = [NSMutableString string];
        pid_t me = getpid();
        for (NSNumber *n in objectList(kAudioObjectSystemObject, kAudioHardwarePropertyProcessObjectList)) {
            AudioObjectID obj = n.unsignedIntValue;
            pid_t pid = processPID(obj);
            if (pid <= 0 || pid == me) continue;

            NSString *appPath = @"", *name = nil, *bundleID = stringProp(obj, kAudioProcessPropertyBundleID);
            char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
            if (proc_pidpath(pid, path, sizeof(path)) > 0) {
                // Helpers live inside their app (Foo.app/Contents/.../Helper.app),
                // so the first ".app/" in the path is the app the DJ knows.
                NSString *exe = [NSString stringWithUTF8String:path];
                NSRange r = [exe rangeOfString:@".app/"];
                if (r.location != NSNotFound) {
                    appPath = [exe substringToIndex:r.location + 4];
                    NSBundle *b = [NSBundle bundleWithPath:appPath];
                    name = [b objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: [b objectForInfoDictionaryKey:@"CFBundleName"];
                    if (b.bundleIdentifier) bundleID = b.bundleIdentifier;
                    if (!name.length) name = appPath.lastPathComponent.stringByDeletingPathExtension;
                } else {
                    name = exe.lastPathComponent;
                }
            }
            if (!name.length) {
                char buf[2 * MAXCOMLEN + 1] = {0};
                name = proc_name(pid, buf, sizeof(buf)) > 0 ? [NSString stringWithUTF8String:buf] : @"?";
            }
            [out appendFormat:@"%d\t%d\t%@\t%@\t%@\n", pid, processIsPlaying(obj), clean(appPath), clean(name), clean(bundleID)];
        }
        return strdup(out.UTF8String);
    }
}

void *sd_app_icon_png(const char *appPath, int size, int *len) {
    @autoreleasepool {
        NSString *path = [NSString stringWithUTF8String:appPath];
        if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return NULL;
        NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:path];
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:size pixelsHigh:size
            bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
        [icon drawInRect:NSMakeRect(0, 0, size, size) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1.0];
        [NSGraphicsContext restoreGraphicsState];
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png.length) return NULL;
        void *bytes = malloc(png.length);
        memcpy(bytes, png.bytes, png.length);
        *len = (int)png.length;
        return bytes;
    }
}

// --- Input devices -----------------------------------------------------------

static UInt32 inputChannels(AudioObjectID dev) {
    AudioObjectPropertyAddress a = {kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &size) != noErr || size == 0) return 0;
    AudioBufferList *list = malloc(size);
    UInt32 ch = 0;
    if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, list) == noErr) {
        for (UInt32 i = 0; i < list->mNumberBuffers; i++) ch += list->mBuffers[i].mNumberChannels;
    }
    free(list);
    return ch;
}

char *sd_list_inputs(void) {
    @autoreleasepool {
        NSMutableString *out = [NSMutableString string];
        for (NSNumber *n in objectList(kAudioObjectSystemObject, kAudioHardwarePropertyDevices)) {
            AudioObjectID dev = n.unsignedIntValue;
            UInt32 ch = inputChannels(dev);
            if (ch == 0) continue;
            NSString *name = stringProp(dev, kAudioObjectPropertyName);
            if ([name hasPrefix:@"CADefaultDeviceAggregate"]) continue;
            [out appendFormat:@"%@\t%@\t%u\n", clean(stringProp(dev, kAudioDevicePropertyDeviceUID)), clean(name), ch];
        }
        return strdup(out.UTF8String);
    }
}

static AudioObjectID deviceWithUID(NSString *uid) {
    for (NSNumber *n in objectList(kAudioObjectSystemObject, kAudioHardwarePropertyDevices)) {
        if ([stringProp(n.unsignedIntValue, kAudioDevicePropertyDeviceUID) isEqualToString:uid]) return n.unsignedIntValue;
    }
    return kAudioObjectUnknown;
}

int sd_mic_status(void) {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
    case AVAuthorizationStatusAuthorized: return 2;
    case AVAuthorizationStatusNotDetermined: return 0;
    default: return 1;
    }
}

int sd_mic_request(void) {
    if (sd_mic_status() != 0) return sd_mic_status();
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    return sd_mic_status();
}

// --- Capture -----------------------------------------------------------------

static NSString *defaultOutputUID(void) {
    AudioObjectPropertyAddress a = addr(kAudioHardwarePropertyDefaultSystemOutputDevice);
    AudioObjectID dev = kAudioObjectUnknown;
    UInt32 size = sizeof(dev);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &dev) != noErr) return nil;
    NSString *uid = stringProp(dev, kAudioDevicePropertyDeviceUID);
    return uid.length ? uid : nil;
}

// Finds channel c across the buffers, whatever the layout.
static BOOL channelAt(const AudioBufferList *in, UInt32 c, const float **base, UInt32 *stride) {
    UInt32 seen = 0;
    for (UInt32 b = 0; b < in->mNumberBuffers; b++) {
        UInt32 nch = in->mBuffers[b].mNumberChannels;
        if (c < seen + nch && in->mBuffers[b].mData) {
            *base = (const float *)in->mBuffers[b].mData + (c - seen);
            *stride = nch;
            return YES;
        }
        seen += nch;
    }
    return NO;
}

// Hands channels 1–2 to Go as interleaved stereo float32 (mono is doubled).
static void deliver(const AudioBufferList *in, Float64 rate) {
    if (!in || in->mNumberBuffers == 0 || in->mBuffers[0].mNumberChannels == 0) return;
    UInt32 frames = in->mBuffers[0].mDataByteSize / (sizeof(float) * in->mBuffers[0].mNumberChannels);
    const float *l, *r;
    UInt32 ls, rs;
    if (frames == 0 || !channelAt(in, 0, &l, &ls)) return;
    if (!channelAt(in, 1, &r, &rs)) { r = l; rs = ls; }
    if (frames > gScratchFrames) {
        gScratch = realloc(gScratch, frames * 2 * sizeof(float));
        gScratchFrames = frames;
    }
    for (UInt32 i = 0; i < frames; i++) {
        gScratch[2 * i] = l[i * ls];
        gScratch[2 * i + 1] = r[i * rs];
    }
    goOnAudio(gScratch, (int)frames, (int)rate);
}

static int runOn(AudioObjectID dev, Float64 rate, char *err, int errLen) {
    if (!gScratch) {
        gScratchFrames = 4096;
        gScratch = malloc(gScratchFrames * 2 * sizeof(float));
    }
    OSStatus st = AudioDeviceCreateIOProcIDWithBlock(&gProc, dev, NULL,
        ^(const AudioTimeStamp *now, const AudioBufferList *inData, const AudioTimeStamp *inTime,
          AudioBufferList *outData, const AudioTimeStamp *outTime) {
            deliver(inData, rate);
            // We never play anything: keep any output side of the device silent.
            if (outData) for (UInt32 i = 0; i < outData->mNumberBuffers; i++)
                if (outData->mBuffers[i].mData) memset(outData->mBuffers[i].mData, 0, outData->mBuffers[i].mDataByteSize);
        });
    if (st != noErr) {
        setErr(err, errLen, [NSString stringWithFormat:@"could not attach to the audio device: %@", statusText(st)]);
        sd_capture_stop();
        return 1;
    }
    gDevice = dev;
    if ((st = AudioDeviceStart(dev, gProc)) != noErr) {
        setErr(err, errLen, [NSString stringWithFormat:@"could not start capturing: %@", statusText(st)]);
        sd_capture_stop();
        return 1;
    }
    return 0;
}

int sd_tap_start(const int *pids, int n, char *err, int errLen) {
    @autoreleasepool {
        sd_capture_stop();
        CATapDescription *desc;
        if (n == 0) {
            desc = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
        } else {
            NSMutableArray<NSNumber *> *objs = [NSMutableArray array];
            for (int i = 0; i < n; i++) {
                AudioObjectID obj = processObject(pids[i]);
                if (obj != kAudioObjectUnknown) [objs addObject:@(obj)];
            }
            if (objs.count == 0) {
                setErr(err, errLen, @"that app isn't running any more");
                return 1;
            }
            desc = [[CATapDescription alloc] initStereoMixdownOfProcesses:objs];
        }
        desc.name = @"Silent Disco";
        desc.privateTap = YES;
        desc.muteBehavior = CATapUnmuted; // the DJ still hears everything locally

        OSStatus st = AudioHardwareCreateProcessTap(desc, &gTap);
        if (st != noErr) {
            gTap = kAudioObjectUnknown;
            setErr(err, errLen, [NSString stringWithFormat:@"could not create the audio tap: %@", statusText(st)]);
            return 1;
        }

        AudioStreamBasicDescription fmt = {0};
        AudioObjectPropertyAddress a = addr(kAudioTapPropertyFormat);
        UInt32 size = sizeof(fmt);
        if ((st = AudioObjectGetPropertyData(gTap, &a, 0, NULL, &size, &fmt)) != noErr) {
            setErr(err, errLen, [NSString stringWithFormat:@"could not read the tap format: %@", statusText(st)]);
            sd_capture_stop();
            return 1;
        }
        Float64 rate = fmt.mSampleRate > 0 ? fmt.mSampleRate : 48000;

        // A private aggregate device wraps the tap so we can read from it,
        // clocked by the current output device.
        NSString *outUID = defaultOutputUID();
        NSMutableDictionary *agg = [@{
            @kAudioAggregateDeviceNameKey : @"Silent Disco Tap",
            @kAudioAggregateDeviceUIDKey : [[NSUUID UUID] UUIDString],
            @kAudioAggregateDeviceIsPrivateKey : @YES,
            @kAudioAggregateDeviceIsStackedKey : @NO,
            @kAudioAggregateDeviceTapAutoStartKey : @YES,
            @kAudioAggregateDeviceTapListKey : @[ @{
                @kAudioSubTapDriftCompensationKey : @YES,
                @kAudioSubTapUIDKey : desc.UUID.UUIDString,
            } ],
        } mutableCopy];
        if (outUID) {
            agg[@kAudioAggregateDeviceMainSubDeviceKey] = outUID;
            agg[@kAudioAggregateDeviceSubDeviceListKey] = @[ @{@kAudioSubDeviceUIDKey : outUID} ];
        }
        if ((st = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)agg, &gAggregate)) != noErr) {
            gAggregate = kAudioObjectUnknown;
            setErr(err, errLen, [NSString stringWithFormat:@"could not create the capture device: %@", statusText(st)]);
            sd_capture_stop();
            return 1;
        }
        return runOn(gAggregate, rate, err, errLen);
    }
}

int sd_input_start(const char *uid, char *err, int errLen) {
    @autoreleasepool {
        sd_capture_stop();
        AudioObjectID dev = deviceWithUID([NSString stringWithUTF8String:uid]);
        if (dev == kAudioObjectUnknown) {
            setErr(err, errLen, @"that input isn't connected");
            return 1;
        }
        Float64 rate = 48000;
        AudioObjectPropertyAddress a = addr(kAudioDevicePropertyNominalSampleRate);
        UInt32 size = sizeof(rate);
        AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &rate);
        return runOn(dev, rate > 0 ? rate : 48000, err, errLen);
    }
}

void sd_capture_stop(void) {
    if (gDevice != kAudioObjectUnknown && gProc) {
        AudioDeviceStop(gDevice, gProc);
        AudioDeviceDestroyIOProcID(gDevice, gProc);
    }
    gProc = NULL;
    gDevice = kAudioObjectUnknown;
    if (gAggregate != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(gAggregate);
    gAggregate = kAudioObjectUnknown;
    if (gTap != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(gTap);
    gTap = kAudioObjectUnknown;
}
