#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#import <signal.h>
#import <unistd.h>

// stdout is mono 16 kHz Float32 PCM. stdin belongs to the Electron parent.
static AudioObjectID meetingProcess(void) {
    AudioObjectPropertyAddress list = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, 0};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &list, 0, NULL, &size)) return 0;
    NSMutableData *data = [NSMutableData dataWithLength:size];
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &list, 0, NULL, &size, data.mutableBytes)) return 0;
    const AudioObjectID *ids = data.bytes;
    for (UInt32 i = 0; i < size / sizeof(*ids); i++) {
        AudioObjectPropertyAddress prop = {kAudioProcessPropertyBundleID, kAudioObjectPropertyScopeGlobal, 0};
        CFStringRef bundle = NULL;
        UInt32 bytes = sizeof(bundle);
        if (AudioObjectGetPropertyData(ids[i], &prop, 0, NULL, &bytes, &bundle)) continue;
        if ([CFBridgingRelease(bundle) isEqualToString:@"com.tencent.meeting"]) return ids[i];
    }
    return 0;
}

static OSStatus recordMeeting(AudioObjectID process) {
    CATapDescription *desc = [[CATapDescription alloc] initMonoMixdownOfProcesses:@[@(process)]];
    desc.name = @"MeetingCopilot 腾讯会议直采";
    desc.private = YES;
    desc.muteBehavior = CATapUnmuted;
    AudioObjectID tap = 0, device = 0;
    AudioDeviceIOProcID io = NULL;
    OSStatus status = AudioHardwareCreateProcessTap(desc, &tap);
    if (status) return status;
    NSDictionary *config = @{
        @kAudioAggregateDeviceNameKey: desc.name,
        @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
        @kAudioAggregateDeviceIsPrivateKey: @YES,
        @kAudioAggregateDeviceTapAutoStartKey: @YES,
        @kAudioAggregateDeviceTapListKey: @[@{@kAudioSubTapUIDKey: desc.UUID.UUIDString}]
    };
    @try {
        status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)config, &device);
        if (status) return status;
        AudioObjectPropertyAddress address = {kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, 0};
        AudioStreamBasicDescription format = {0};
        UInt32 bytes = sizeof(format);
        status = AudioObjectGetPropertyData(tap, &address, 0, NULL, &bytes, &format);
        if (status) return status;
        AVAudioFormat *source = [[AVAudioFormat alloc] initWithStreamDescription:&format];
        AVAudioFormat *target = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:16000 channels:1];
        AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:source toFormat:target];
        if (!converter || !format.mBytesPerFrame) return kAudioFormatUnsupportedDataFormatError;
        dispatch_queue_t queue = dispatch_queue_create("meetingcopilot.audio", DISPATCH_QUEUE_SERIAL);
        status = AudioDeviceCreateIOProcIDWithBlock(&io, device, queue, ^(const AudioTimeStamp *now,
            const AudioBufferList *input, const AudioTimeStamp *inputTime, AudioBufferList *output,
            const AudioTimeStamp *outputTime) {
            @autoreleasepool {
                if (!input->mNumberBuffers || !input->mBuffers[0].mDataByteSize) return;
                AVAudioPCMBuffer *inBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:source
                    bufferListNoCopy:input deallocator:nil];
                if (!inBuffer) return;
                inBuffer.frameLength = input->mBuffers[0].mDataByteSize / format.mBytesPerFrame;
                AVAudioFrameCount capacity = (AVAudioFrameCount)ceil(inBuffer.frameLength * 16000.0 / format.mSampleRate) + 64;
                AVAudioPCMBuffer *outBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:target frameCapacity:capacity];
                __block BOOL available = YES;
                NSError *error = nil;
                [converter convertToBuffer:outBuffer error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *state) {
                    if (!available) { *state = AVAudioConverterInputStatus_NoDataNow; return nil; }
                    available = NO;
                    *state = AVAudioConverterInputStatus_HaveData;
                    return inBuffer;
                }];
                if (error) { fprintf(stderr, "Audio conversion failed\n"); _exit(1); }
                if (outBuffer.frameLength) {
                    size_t count = outBuffer.frameLength * sizeof(float);
                    if (fwrite(outBuffer.floatChannelData[0], 1, count, stdout) != count) _exit(1);
                }
            }
        });
        if (status) return status;
        status = AudioDeviceStart(device, io);
        if (status) return status;
        fprintf(stderr, "READY\n");
        char unused;
        while (read(STDIN_FILENO, &unused, 1) > 0) {}
    } @finally {
        if (io) { AudioDeviceStop(device, io); AudioDeviceDestroyIOProcID(device, io); }
        if (device) AudioHardwareDestroyAggregateDevice(device);
        AudioHardwareDestroyProcessTap(tap);
    }
    return status;
}

int main(void) {
    @autoreleasepool {
        setvbuf(stdout, NULL, _IONBF, 0);
        AudioObjectID process = meetingProcess();
        if (!process) { fprintf(stderr, "请先打开腾讯会议，然后重试。\n"); return 1; }
        OSStatus status = recordMeeting(process);
        if (status) fprintf(stderr, "腾讯会议音频采集启动失败 (%d)。请检查 macOS 的系统录音权限。\n", (int)status);
        return status ? 1 : 0;
    }
}
