#include "plugin_host.h"
#include <sstream>

namespace FieldCorder {

struct PluginHost::PluginInstance {
    std::string id;
    std::string name;
    std::string path;
    std::string format; // "VST3" or "AudioUnit"
    std::vector<ParameterInfo> parameters;
    // Native plugin handle would go here
    // void* nativeHandle = nullptr;
};

PluginHost::PluginHost() {}

PluginHost::~PluginHost() {
    instances_.clear();
}

LoadResult PluginHost::loadPlugin(const std::string& path) {
    // Determine plugin format from path
    if (path.find(".vst3") != std::string::npos) {
        return loadVST3(path);
    } else if (path.find(".component") != std::string::npos) {
        return loadAudioUnit(path);
    }

    LoadResult result;
    result.success = false;
    result.errorMessage = "Unknown plugin format: " + path;
    return result;
}

LoadResult PluginHost::loadAudioUnit(const std::string& path) {
    LoadResult result;

#ifdef __APPLE__
    // TODO: Implement AudioUnit loading using AudioToolbox framework
    //
    // Steps:
    // 1. Open the .component bundle
    // 2. Use AudioComponentFindNext to find the component
    // 3. AudioComponentInstanceNew to create an instance
    // 4. AudioUnitInitialize to initialize
    // 5. Query parameters using AudioUnitGetPropertyInfo/AudioUnitGetProperty
    //
    // For now, create a placeholder instance
    std::string pluginId = "au_" + std::to_string(nextId_++);

    auto instance = std::make_unique<PluginInstance>();
    instance->id = pluginId;
    instance->path = path;
    instance->format = "AudioUnit";

    // Extract name from path
    size_t lastSlash = path.find_last_of('/');
    size_t lastDot = path.find_last_of('.');
    if (lastSlash != std::string::npos && lastDot != std::string::npos) {
        instance->name = path.substr(lastSlash + 1, lastDot - lastSlash - 1);
    } else {
        instance->name = path;
    }

    result.success = true;
    result.pluginId = pluginId;
    result.name = instance->name;
    result.parameters = instance->parameters;

    instances_[pluginId] = std::move(instance);
#else
    result.success = false;
    result.errorMessage = "AudioUnit plugins are only supported on macOS";
#endif

    return result;
}

LoadResult PluginHost::loadVST3(const std::string& path) {
    LoadResult result;

#ifdef HAS_VST3_SDK
    // TODO: Implement VST3 loading using VST3 SDK
    //
    // Steps:
    // 1. Load the .vst3 bundle
    // 2. Get the module factory
    // 3. Create the component (IComponent)
    // 4. Initialize the component
    // 5. Get the controller (IEditController)
    // 6. Query parameters
    //
    // Requires VST3 SDK headers and linking
    result.success = false;
    result.errorMessage = "VST3 loading not yet implemented";
#else
    // Without VST3 SDK, create a placeholder
    std::string pluginId = "vst3_" + std::to_string(nextId_++);

    auto instance = std::make_unique<PluginInstance>();
    instance->id = pluginId;
    instance->path = path;
    instance->format = "VST3";

    size_t lastSlash = path.find_last_of('/');
    size_t lastDot = path.find_last_of('.');
    if (lastSlash != std::string::npos && lastDot != std::string::npos) {
        instance->name = path.substr(lastSlash + 1, lastDot - lastSlash - 1);
    } else {
        instance->name = path;
    }

    result.success = true;
    result.pluginId = pluginId;
    result.name = instance->name;
    result.parameters = instance->parameters;

    instances_[pluginId] = std::move(instance);
#endif

    return result;
}

void PluginHost::unloadPlugin(const std::string& pluginId) {
    auto it = instances_.find(pluginId);
    if (it != instances_.end()) {
        // TODO: Properly cleanup native plugin resources
        instances_.erase(it);
    }
}

std::vector<ParameterInfo> PluginHost::getParameters(const std::string& pluginId) {
    auto it = instances_.find(pluginId);
    if (it != instances_.end()) {
        return it->second->parameters;
    }
    return {};
}

void PluginHost::setParameter(const std::string& pluginId, int paramId, double value) {
    auto it = instances_.find(pluginId);
    if (it != instances_.end()) {
        for (auto& param : it->second->parameters) {
            if (param.id == paramId) {
                param.value = value;
                // TODO: Forward to native plugin
                break;
            }
        }
    }
}

void PluginHost::processAudio(const std::string& pluginId,
                              float** inputBuffers, float** outputBuffers,
                              int numChannels, int numSamples, double sampleRate) {
    auto it = instances_.find(pluginId);
    if (it == instances_.end()) return;

    // TODO: Process audio through native plugin
    // For now, pass-through
    for (int ch = 0; ch < numChannels; ch++) {
        if (inputBuffers[ch] && outputBuffers[ch]) {
            std::memcpy(outputBuffers[ch], inputBuffers[ch], numSamples * sizeof(float));
        }
    }
}

} // namespace FieldCorder
