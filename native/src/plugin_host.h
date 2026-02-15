#pragma once

#include <string>
#include <vector>
#include <map>
#include <memory>

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

/**
 * Plugin Host for VST3 and AudioUnit plugins.
 *
 * On macOS, AudioUnit plugins are loaded via the AudioToolbox framework.
 * VST3 plugins require the VST3 SDK to be available at build time.
 *
 * This is a skeleton implementation. Full VST3/AU hosting requires:
 * - VST3 SDK for VST3 plugins (https://github.com/steinbergmedia/vst3sdk)
 * - AudioToolbox/AudioUnit frameworks for AU plugins (included in macOS SDK)
 */
class PluginHost {
public:
    PluginHost();
    ~PluginHost();

    LoadResult loadPlugin(const std::string& path);
    void unloadPlugin(const std::string& pluginId);

    std::vector<ParameterInfo> getParameters(const std::string& pluginId);
    void setParameter(const std::string& pluginId, int paramId, double value);

    // Process audio through a loaded plugin
    void processAudio(const std::string& pluginId,
                      float** inputBuffers, float** outputBuffers,
                      int numChannels, int numSamples, double sampleRate);

private:
    struct PluginInstance;
    std::map<std::string, std::unique_ptr<PluginInstance>> instances_;
    int nextId_ = 1;

    LoadResult loadAudioUnit(const std::string& path);
    LoadResult loadVST3(const std::string& path);
};

} // namespace FieldCorder
