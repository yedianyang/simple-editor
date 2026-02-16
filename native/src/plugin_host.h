#pragma once

#include <string>
#include <vector>
#include <map>
#include <memory>

#ifdef __APPLE__
#include <AudioToolbox/AudioToolbox.h>
#endif

namespace FieldCorder {

struct ParameterInfo {
    int id;
    std::string name;
    double value;
    double min;
    double max;
    double defaultValue;
};

struct LoadResult {
    bool success;
    std::string pluginId;
    std::string name;
    std::string errorMessage;
    std::vector<ParameterInfo> parameters;
};

struct ScanResultItem {
    std::string id;       // "aufx:bpas:appl" (type:subtype:manufacturer)
    std::string name;     // "AUBandpass"
    std::string category; // "effect", "instrument", "generator", "music-effect"
    std::string format;   // "AudioUnit"
    std::string vendor;   // Manufacturer name
};

/**
 * Plugin Host for AudioUnit plugins on macOS.
 *
 * Uses AudioToolbox framework to scan, load, and process AU plugins.
 * Audio processing uses AudioUnitRender for sample-accurate plugin processing.
 */
class PluginHost {
public:
    PluginHost();
    ~PluginHost();

    // Scan system for installed AudioUnit plugins
    std::vector<ScanResultItem> scanAudioUnits();

    // Load a plugin by its AU identifier (e.g. "aufx:bpas:appl")
    LoadResult loadPlugin(const std::string& pluginIdentifier);
    void unloadPlugin(const std::string& pluginId);

    std::vector<ParameterInfo> getParameters(const std::string& pluginId);
    void setParameter(const std::string& pluginId, int paramId, double value);

    // Configure audio format before processing
    bool configureAudio(const std::string& pluginId, double sampleRate,
                        int numChannels, int maxFrames);

    // Process audio through a loaded plugin
    void processAudio(const std::string& pluginId,
                      float** inputBuffers, float** outputBuffers,
                      int numChannels, int numSamples, double sampleRate);

private:
    struct PluginInstance;
    std::map<std::string, std::unique_ptr<PluginInstance>> instances_;
    int nextId_ = 1;

    LoadResult loadAudioUnit(const std::string& identifier);
    LoadResult loadVST3(const std::string& path);

#ifdef __APPLE__
    // Parse AU identifier string "type:subtype:manufacturer" into component description
    static bool parseAUIdentifier(const std::string& identifier,
                                  AudioComponentDescription& desc);
    // Convert OSType to 4-char string
    static std::string fourCCToString(UInt32 value);
    // Convert 4-char string to OSType
    static UInt32 stringToFourCC(const std::string& str);
    // Query parameters from an AU instance
    static std::vector<ParameterInfo> queryAUParameters(AudioComponentInstance instance);
#endif
};

} // namespace FieldCorder
