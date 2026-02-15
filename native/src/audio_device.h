#pragma once

#include <string>
#include <vector>

namespace FieldCorder {

struct AudioDeviceInfo {
    int id;
    std::string name;
    int inputChannels;
    int outputChannels;
    double sampleRate;
};

/**
 * Core Audio device enumeration and management for macOS.
 */
class AudioDevice {
public:
    static std::vector<AudioDeviceInfo> getDevices();
    static AudioDeviceInfo getDefaultInputDevice();
    static AudioDeviceInfo getDefaultOutputDevice();
};

} // namespace FieldCorder
