#include "audio_device.h"

#ifdef __APPLE__
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#endif

namespace FieldCorder {

std::vector<AudioDeviceInfo> AudioDevice::getDevices() {
    std::vector<AudioDeviceInfo> devices;

#ifdef __APPLE__
    AudioObjectPropertyAddress propertyAddress = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(
        kAudioObjectSystemObject, &propertyAddress, 0, nullptr, &dataSize);

    if (status != noErr) return devices;

    int deviceCount = dataSize / sizeof(AudioDeviceID);
    std::vector<AudioDeviceID> deviceIDs(deviceCount);

    status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &propertyAddress, 0, nullptr, &dataSize, deviceIDs.data());

    if (status != noErr) return devices;

    for (int i = 0; i < deviceCount; i++) {
        AudioDeviceInfo info;
        info.id = deviceIDs[i];

        // Get device name
        CFStringRef nameRef = nullptr;
        UInt32 nameSize = sizeof(CFStringRef);
        AudioObjectPropertyAddress nameAddress = {
            kAudioDevicePropertyDeviceNameCFString,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        status = AudioObjectGetPropertyData(
            deviceIDs[i], &nameAddress, 0, nullptr, &nameSize, &nameRef);

        if (status == noErr && nameRef) {
            char nameBuf[256];
            CFStringGetCString(nameRef, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
            info.name = nameBuf;
            CFRelease(nameRef);
        }

        // Get input channel count
        AudioObjectPropertyAddress inputAddress = {
            kAudioDevicePropertyStreamConfiguration,
            kAudioDevicePropertyScopeInput,
            kAudioObjectPropertyElementMain
        };

        UInt32 inputSize = 0;
        status = AudioObjectGetPropertyDataSize(deviceIDs[i], &inputAddress, 0, nullptr, &inputSize);

        info.inputChannels = 0;
        if (status == noErr && inputSize > 0) {
            std::vector<char> inputBuf(inputSize);
            AudioBufferList* bufferList = reinterpret_cast<AudioBufferList*>(inputBuf.data());
            status = AudioObjectGetPropertyData(
                deviceIDs[i], &inputAddress, 0, nullptr, &inputSize, bufferList);

            if (status == noErr) {
                for (UInt32 j = 0; j < bufferList->mNumberBuffers; j++) {
                    info.inputChannels += bufferList->mBuffers[j].mNumberChannels;
                }
            }
        }

        // Get output channel count
        AudioObjectPropertyAddress outputAddress = {
            kAudioDevicePropertyStreamConfiguration,
            kAudioDevicePropertyScopeOutput,
            kAudioObjectPropertyElementMain
        };

        UInt32 outputSize = 0;
        status = AudioObjectGetPropertyDataSize(deviceIDs[i], &outputAddress, 0, nullptr, &outputSize);

        info.outputChannels = 0;
        if (status == noErr && outputSize > 0) {
            std::vector<char> outputBuf(outputSize);
            AudioBufferList* bufferList = reinterpret_cast<AudioBufferList*>(outputBuf.data());
            status = AudioObjectGetPropertyData(
                deviceIDs[i], &outputAddress, 0, nullptr, &outputSize, bufferList);

            if (status == noErr) {
                for (UInt32 j = 0; j < bufferList->mNumberBuffers; j++) {
                    info.outputChannels += bufferList->mBuffers[j].mNumberChannels;
                }
            }
        }

        // Get sample rate
        Float64 sampleRate = 0;
        UInt32 srSize = sizeof(Float64);
        AudioObjectPropertyAddress srAddress = {
            kAudioDevicePropertyNominalSampleRate,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        status = AudioObjectGetPropertyData(
            deviceIDs[i], &srAddress, 0, nullptr, &srSize, &sampleRate);

        info.sampleRate = (status == noErr) ? sampleRate : 44100.0;

        // Only include devices with audio channels
        if (info.inputChannels > 0 || info.outputChannels > 0) {
            devices.push_back(info);
        }
    }
#endif

    return devices;
}

AudioDeviceInfo AudioDevice::getDefaultInputDevice() {
    AudioDeviceInfo info = {};

#ifdef __APPLE__
    AudioDeviceID deviceId = 0;
    UInt32 size = sizeof(AudioDeviceID);
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &address, 0, nullptr, &size, &deviceId);

    if (status == noErr) {
        info.id = deviceId;
        // Get name
        CFStringRef nameRef = nullptr;
        UInt32 nameSize = sizeof(CFStringRef);
        AudioObjectPropertyAddress nameAddress = {
            kAudioDevicePropertyDeviceNameCFString,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        status = AudioObjectGetPropertyData(deviceId, &nameAddress, 0, nullptr, &nameSize, &nameRef);
        if (status == noErr && nameRef) {
            char nameBuf[256];
            CFStringGetCString(nameRef, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
            info.name = nameBuf;
            CFRelease(nameRef);
        }
    }
#endif

    return info;
}

AudioDeviceInfo AudioDevice::getDefaultOutputDevice() {
    AudioDeviceInfo info = {};

#ifdef __APPLE__
    AudioDeviceID deviceId = 0;
    UInt32 size = sizeof(AudioDeviceID);
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject, &address, 0, nullptr, &size, &deviceId);

    if (status == noErr) {
        info.id = deviceId;
        CFStringRef nameRef = nullptr;
        UInt32 nameSize = sizeof(CFStringRef);
        AudioObjectPropertyAddress nameAddress = {
            kAudioDevicePropertyDeviceNameCFString,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        status = AudioObjectGetPropertyData(deviceId, &nameAddress, 0, nullptr, &nameSize, &nameRef);
        if (status == noErr && nameRef) {
            char nameBuf[256];
            CFStringGetCString(nameRef, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
            info.name = nameBuf;
            CFRelease(nameRef);
        }
    }
#endif

    return info;
}

} // namespace FieldCorder
