#include "plugin_host.h"
#include <sstream>
#include <cstring>
#include <cmath>

#ifdef __APPLE__
#include <AudioToolbox/AudioToolbox.h>
#include <AudioUnit/AudioUnit.h>
#endif

namespace FieldCorder {

struct PluginHost::PluginInstance {
    std::string id;
    std::string name;
    std::string identifier; // AU: "aufx:bpas:appl", VST3: path
    std::string format;     // "AudioUnit" or "VST3"
    std::vector<ParameterInfo> parameters;

#ifdef __APPLE__
    AudioComponentInstance auInstance = nullptr;
    AudioStreamBasicDescription streamFormat = {};
    bool initialized = false;
    UInt32 maxFrames = 4096;
#endif
};

PluginHost::PluginHost() {}

PluginHost::~PluginHost() {
    // Properly dispose all AU instances
    for (auto& [id, instance] : instances_) {
#ifdef __APPLE__
        if (instance->auInstance) {
            if (instance->initialized) {
                AudioUnitUninitialize(instance->auInstance);
            }
            AudioComponentInstanceDispose(instance->auInstance);
            instance->auInstance = nullptr;
        }
#endif
    }
    instances_.clear();
}

// ==================== Scanning ====================

std::vector<ScanResultItem> PluginHost::scanAudioUnits() {
    std::vector<ScanResultItem> results;

#ifdef __APPLE__
    // AU component types to scan
    struct TypeInfo {
        UInt32 type;
        std::string category;
    };

    std::vector<TypeInfo> typesToScan = {
        { kAudioUnitType_Effect,        "effect" },
        { kAudioUnitType_MusicEffect,   "music-effect" },
        { kAudioUnitType_Generator,     "generator" },
        { kAudioUnitType_MusicDevice,   "instrument" },
        { kAudioUnitType_Mixer,         "mixer" },
        { kAudioUnitType_Panner,        "panner" },
    };

    for (const auto& typeInfo : typesToScan) {
        AudioComponentDescription desc = {};
        desc.componentType = typeInfo.type;
        desc.componentSubType = 0;
        desc.componentManufacturer = 0;
        desc.componentFlags = 0;
        desc.componentFlagsMask = 0;

        AudioComponent component = nullptr;
        while ((component = AudioComponentFindNext(component, &desc)) != nullptr) {
            ScanResultItem item;
            item.format = "AudioUnit";
            item.category = typeInfo.category;

            // Get component name
            CFStringRef nameRef = nullptr;
            if (AudioComponentCopyName(component, &nameRef) == noErr && nameRef) {
                char nameBuf[512];
                CFStringGetCString(nameRef, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
                item.name = nameBuf;
                CFRelease(nameRef);
            }

            // Get component description for identifier
            AudioComponentDescription compDesc = {};
            if (AudioComponentGetDescription(component, &compDesc) == noErr) {
                // Build identifier: "type:subtype:manufacturer"
                item.id = fourCCToString(compDesc.componentType) + ":" +
                          fourCCToString(compDesc.componentSubType) + ":" +
                          fourCCToString(compDesc.componentManufacturer);

                // Extract vendor from manufacturer code
                item.vendor = fourCCToString(compDesc.componentManufacturer);
            }

            if (!item.id.empty() && !item.name.empty()) {
                results.push_back(item);
            }
        }
    }
#endif

    return results;
}

// ==================== Loading ====================

LoadResult PluginHost::loadPlugin(const std::string& identifier) {
    // If it looks like a VST3 path
    if (identifier.find(".vst3") != std::string::npos) {
        return loadVST3(identifier);
    }
    // Otherwise treat as AudioUnit identifier
    return loadAudioUnit(identifier);
}

LoadResult PluginHost::loadAudioUnit(const std::string& identifier) {
    LoadResult result;

#ifdef __APPLE__
    // Parse the identifier into AudioComponentDescription
    AudioComponentDescription desc = {};
    if (!parseAUIdentifier(identifier, desc)) {
        result.success = false;
        result.errorMessage = "Invalid AudioUnit identifier: " + identifier;
        return result;
    }

    // Find the component
    AudioComponent component = AudioComponentFindNext(nullptr, &desc);
    if (!component) {
        result.success = false;
        result.errorMessage = "AudioUnit component not found: " + identifier;
        return result;
    }

    // Create instance
    AudioComponentInstance auInstance = nullptr;
    OSStatus status = AudioComponentInstanceNew(component, &auInstance);
    if (status != noErr) {
        result.success = false;
        result.errorMessage = "Failed to create AudioUnit instance (error " +
                              std::to_string(status) + ")";
        return result;
    }

    // Set default stream format (44.1kHz stereo float32 non-interleaved)
    AudioStreamBasicDescription streamFormat = {};
    streamFormat.mSampleRate = 44100.0;
    streamFormat.mFormatID = kAudioFormatLinearPCM;
    streamFormat.mFormatFlags = kAudioFormatFlagIsFloat |
                                kAudioFormatFlagIsPacked |
                                kAudioFormatFlagIsNonInterleaved;
    streamFormat.mBitsPerChannel = 32;
    streamFormat.mChannelsPerFrame = 2;
    streamFormat.mFramesPerPacket = 1;
    streamFormat.mBytesPerFrame = sizeof(Float32);
    streamFormat.mBytesPerPacket = sizeof(Float32);

    // Set format on input and output busses
    status = AudioUnitSetProperty(auInstance,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Input, 0,
        &streamFormat, sizeof(streamFormat));

    if (status != noErr) {
        // Some plugins may not accept this format on input; try output only
    }

    status = AudioUnitSetProperty(auInstance,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output, 0,
        &streamFormat, sizeof(streamFormat));

    // Set max frames per slice
    UInt32 maxFrames = 4096;
    AudioUnitSetProperty(auInstance,
        kAudioUnitProperty_MaximumFramesPerSlice,
        kAudioUnitScope_Global, 0,
        &maxFrames, sizeof(maxFrames));

    // Initialize the audio unit
    status = AudioUnitInitialize(auInstance);
    if (status != noErr) {
        AudioComponentInstanceDispose(auInstance);
        result.success = false;
        result.errorMessage = "Failed to initialize AudioUnit (error " +
                              std::to_string(status) + ")";
        return result;
    }

    // Get plugin name
    std::string pluginName;
    CFStringRef nameRef = nullptr;
    if (AudioComponentCopyName(component, &nameRef) == noErr && nameRef) {
        char nameBuf[512];
        CFStringGetCString(nameRef, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
        pluginName = nameBuf;
        CFRelease(nameRef);
    }

    // Query parameters
    auto parameters = queryAUParameters(auInstance);

    // Create plugin instance
    std::string pluginId = "au_" + std::to_string(nextId_++);

    auto instance = std::make_unique<PluginInstance>();
    instance->id = pluginId;
    instance->name = pluginName;
    instance->identifier = identifier;
    instance->format = "AudioUnit";
    instance->parameters = parameters;
    instance->auInstance = auInstance;
    instance->streamFormat = streamFormat;
    instance->initialized = true;
    instance->maxFrames = maxFrames;

    result.success = true;
    result.pluginId = pluginId;
    result.name = pluginName;
    result.parameters = parameters;

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
    // VST3 SDK loading - not yet implemented
    result.success = false;
    result.errorMessage = "VST3 loading not yet implemented";
#else
    result.success = false;
    result.errorMessage = "VST3 SDK not available. Build with -DVST3_SDK_PATH to enable.";
#endif

    return result;
}

// ==================== Parameters ====================

std::vector<ParameterInfo> PluginHost::getParameters(const std::string& pluginId) {
    auto it = instances_.find(pluginId);
    if (it != instances_.end()) {
        return it->second->parameters;
    }
    return {};
}

void PluginHost::setParameter(const std::string& pluginId, int paramId, double value) {
    auto it = instances_.find(pluginId);
    if (it == instances_.end()) return;

    auto& instance = it->second;

    // Update cached value
    for (auto& param : instance->parameters) {
        if (param.id == paramId) {
            param.value = value;
            break;
        }
    }

#ifdef __APPLE__
    if (instance->auInstance) {
        AudioUnitSetParameter(instance->auInstance,
            static_cast<AudioUnitParameterID>(paramId),
            kAudioUnitScope_Global, 0,
            static_cast<AudioUnitParameterValue>(value), 0);
    }
#endif
}

// ==================== Audio Configuration ====================

bool PluginHost::configureAudio(const std::string& pluginId, double sampleRate,
                                int numChannels, int maxFrames) {
#ifdef __APPLE__
    auto it = instances_.find(pluginId);
    if (it == instances_.end()) return false;

    auto& instance = it->second;
    if (!instance->auInstance) return false;

    // Uninitialize before changing format
    if (instance->initialized) {
        AudioUnitUninitialize(instance->auInstance);
        instance->initialized = false;
    }

    // Update stream format
    instance->streamFormat.mSampleRate = sampleRate;
    instance->streamFormat.mChannelsPerFrame = static_cast<UInt32>(numChannels);
    instance->maxFrames = static_cast<UInt32>(maxFrames);

    OSStatus status;

    // Set input format
    status = AudioUnitSetProperty(instance->auInstance,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Input, 0,
        &instance->streamFormat, sizeof(instance->streamFormat));

    // Set output format
    status = AudioUnitSetProperty(instance->auInstance,
        kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output, 0,
        &instance->streamFormat, sizeof(instance->streamFormat));

    // Set max frames
    UInt32 mf = static_cast<UInt32>(maxFrames);
    AudioUnitSetProperty(instance->auInstance,
        kAudioUnitProperty_MaximumFramesPerSlice,
        kAudioUnitScope_Global, 0,
        &mf, sizeof(mf));

    // Re-initialize
    status = AudioUnitInitialize(instance->auInstance);
    if (status != noErr) {
        return false;
    }

    instance->initialized = true;
    return true;
#else
    return false;
#endif
}

// ==================== Audio Processing ====================

void PluginHost::processAudio(const std::string& pluginId,
                              float** inputBuffers, float** outputBuffers,
                              int numChannels, int numSamples, double sampleRate) {
    auto it = instances_.find(pluginId);
    if (it == instances_.end()) {
        // Pass-through if plugin not found
        for (int ch = 0; ch < numChannels; ch++) {
            if (inputBuffers[ch] && outputBuffers[ch]) {
                std::memcpy(outputBuffers[ch], inputBuffers[ch],
                            numSamples * sizeof(float));
            }
        }
        return;
    }

    auto& instance = it->second;

#ifdef __APPLE__
    if (!instance->auInstance || !instance->initialized) {
        // Pass-through
        for (int ch = 0; ch < numChannels; ch++) {
            if (inputBuffers[ch] && outputBuffers[ch]) {
                std::memcpy(outputBuffers[ch], inputBuffers[ch],
                            numSamples * sizeof(float));
            }
        }
        return;
    }

    // Reconfigure if sample rate or channel count changed
    if (instance->streamFormat.mSampleRate != sampleRate ||
        static_cast<int>(instance->streamFormat.mChannelsPerFrame) != numChannels) {
        if (!configureAudio(pluginId, sampleRate, numChannels,
                           std::max(numSamples, static_cast<int>(instance->maxFrames)))) {
            // Config failed, pass-through
            for (int ch = 0; ch < numChannels; ch++) {
                if (inputBuffers[ch] && outputBuffers[ch]) {
                    std::memcpy(outputBuffers[ch], inputBuffers[ch],
                                numSamples * sizeof(float));
                }
            }
            return;
        }
    }

    // Prepare AudioBufferList for output
    UInt32 bufferListSize = offsetof(AudioBufferList, mBuffers) +
                            sizeof(AudioBuffer) * numChannels;
    std::vector<uint8_t> bufferListStorage(bufferListSize);
    AudioBufferList* outputABL = reinterpret_cast<AudioBufferList*>(bufferListStorage.data());
    outputABL->mNumberBuffers = static_cast<UInt32>(numChannels);

    for (int ch = 0; ch < numChannels; ch++) {
        outputABL->mBuffers[ch].mNumberChannels = 1;
        outputABL->mBuffers[ch].mDataByteSize = numSamples * sizeof(Float32);
        outputABL->mBuffers[ch].mData = outputBuffers[ch];
    }

    // Set up render callback to provide input data
    struct RenderCallbackData {
        float** inputBuffers;
        int numChannels;
        int numSamples;
    };

    RenderCallbackData callbackData = { inputBuffers, numChannels, numSamples };

    AURenderCallbackStruct renderCallback;
    renderCallback.inputProcRefCon = &callbackData;
    renderCallback.inputProc = [](void* inRefCon,
                                  AudioUnitRenderActionFlags* ioActionFlags,
                                  const AudioTimeStamp* inTimeStamp,
                                  UInt32 inBusNumber,
                                  UInt32 inNumberFrames,
                                  AudioBufferList* ioData) -> OSStatus {
        auto* data = static_cast<RenderCallbackData*>(inRefCon);
        if (!ioData) return noErr;

        UInt32 framesToCopy = std::min(inNumberFrames,
                                       static_cast<UInt32>(data->numSamples));

        for (UInt32 i = 0; i < ioData->mNumberBuffers; i++) {
            int ch = static_cast<int>(i);
            if (ch < data->numChannels && data->inputBuffers[ch]) {
                std::memcpy(ioData->mBuffers[i].mData,
                           data->inputBuffers[ch],
                           framesToCopy * sizeof(Float32));
            } else {
                std::memset(ioData->mBuffers[i].mData, 0,
                           framesToCopy * sizeof(Float32));
            }
        }
        return noErr;
    };

    // Set the render callback on the input
    OSStatus status = AudioUnitSetProperty(instance->auInstance,
        kAudioUnitProperty_SetRenderCallback,
        kAudioUnitScope_Input, 0,
        &renderCallback, sizeof(renderCallback));

    if (status != noErr) {
        // Fallback: pass-through
        for (int ch = 0; ch < numChannels; ch++) {
            if (inputBuffers[ch] && outputBuffers[ch]) {
                std::memcpy(outputBuffers[ch], inputBuffers[ch],
                            numSamples * sizeof(float));
            }
        }
        return;
    }

    // Render
    AudioTimeStamp timeStamp = {};
    timeStamp.mFlags = kAudioTimeStampSampleTimeValid;
    timeStamp.mSampleTime = 0;

    AudioUnitRenderActionFlags actionFlags = 0;

    status = AudioUnitRender(instance->auInstance,
        &actionFlags, &timeStamp, 0,
        static_cast<UInt32>(numSamples), outputABL);

    if (status != noErr) {
        // Render failed, pass-through
        for (int ch = 0; ch < numChannels; ch++) {
            if (inputBuffers[ch] && outputBuffers[ch]) {
                std::memcpy(outputBuffers[ch], inputBuffers[ch],
                            numSamples * sizeof(float));
            }
        }
    }
#else
    // Non-macOS: pass-through
    for (int ch = 0; ch < numChannels; ch++) {
        if (inputBuffers[ch] && outputBuffers[ch]) {
            std::memcpy(outputBuffers[ch], inputBuffers[ch],
                        numSamples * sizeof(float));
        }
    }
#endif
}

// ==================== Unload ====================

void PluginHost::unloadPlugin(const std::string& pluginId) {
    auto it = instances_.find(pluginId);
    if (it != instances_.end()) {
#ifdef __APPLE__
        auto& instance = it->second;
        if (instance->auInstance) {
            if (instance->initialized) {
                AudioUnitUninitialize(instance->auInstance);
            }
            AudioComponentInstanceDispose(instance->auInstance);
            instance->auInstance = nullptr;
        }
#endif
        instances_.erase(it);
    }
}

// ==================== Helpers ====================

#ifdef __APPLE__

bool PluginHost::parseAUIdentifier(const std::string& identifier,
                                   AudioComponentDescription& desc) {
    // Parse "type:subtype:manufacturer" format
    std::istringstream ss(identifier);
    std::string typeStr, subtypeStr, mfgStr;

    if (!std::getline(ss, typeStr, ':') ||
        !std::getline(ss, subtypeStr, ':') ||
        !std::getline(ss, mfgStr, ':')) {
        return false;
    }

    desc.componentType = stringToFourCC(typeStr);
    desc.componentSubType = stringToFourCC(subtypeStr);
    desc.componentManufacturer = stringToFourCC(mfgStr);
    desc.componentFlags = 0;
    desc.componentFlagsMask = 0;

    return desc.componentType != 0;
}

std::string PluginHost::fourCCToString(UInt32 value) {
    char chars[5] = {
        static_cast<char>((value >> 24) & 0xFF),
        static_cast<char>((value >> 16) & 0xFF),
        static_cast<char>((value >> 8) & 0xFF),
        static_cast<char>(value & 0xFF),
        '\0'
    };
    return std::string(chars);
}

UInt32 PluginHost::stringToFourCC(const std::string& str) {
    if (str.length() < 4) return 0;
    return (static_cast<UInt32>(str[0]) << 24) |
           (static_cast<UInt32>(str[1]) << 16) |
           (static_cast<UInt32>(str[2]) << 8) |
           static_cast<UInt32>(str[3]);
}

std::vector<ParameterInfo> PluginHost::queryAUParameters(AudioComponentInstance instance) {
    std::vector<ParameterInfo> params;

    // Get parameter list
    UInt32 dataSize = 0;
    Boolean writable = false;
    OSStatus status = AudioUnitGetPropertyInfo(instance,
        kAudioUnitProperty_ParameterList,
        kAudioUnitScope_Global, 0,
        &dataSize, &writable);

    if (status != noErr || dataSize == 0) return params;

    UInt32 numParams = dataSize / sizeof(AudioUnitParameterID);
    std::vector<AudioUnitParameterID> paramIds(numParams);

    status = AudioUnitGetProperty(instance,
        kAudioUnitProperty_ParameterList,
        kAudioUnitScope_Global, 0,
        paramIds.data(), &dataSize);

    if (status != noErr) return params;

    // Get info for each parameter
    for (UInt32 i = 0; i < numParams; i++) {
        AudioUnitParameterInfo auParamInfo = {};
        UInt32 infoSize = sizeof(AudioUnitParameterInfo);

        status = AudioUnitGetProperty(instance,
            kAudioUnitProperty_ParameterInfo,
            kAudioUnitScope_Global, paramIds[i],
            &auParamInfo, &infoSize);

        if (status != noErr) continue;

        ParameterInfo paramInfo;
        paramInfo.id = static_cast<int>(paramIds[i]);

        // Get parameter name
        if (auParamInfo.flags & kAudioUnitParameterFlag_HasCFNameString) {
            if (auParamInfo.cfNameString) {
                char nameBuf[256];
                CFStringGetCString(auParamInfo.cfNameString, nameBuf,
                                   sizeof(nameBuf), kCFStringEncodingUTF8);
                paramInfo.name = nameBuf;

                if (auParamInfo.flags & kAudioUnitParameterFlag_CFNameRelease) {
                    CFRelease(auParamInfo.cfNameString);
                }
            }
        }

        if (paramInfo.name.empty()) {
            paramInfo.name = std::string(auParamInfo.name);
        }

        paramInfo.min = auParamInfo.minValue;
        paramInfo.max = auParamInfo.maxValue;
        paramInfo.defaultValue = auParamInfo.defaultValue;

        // Get current value
        AudioUnitParameterValue currentValue = 0;
        status = AudioUnitGetParameter(instance, paramIds[i],
            kAudioUnitScope_Global, 0, &currentValue);
        paramInfo.value = (status == noErr) ? currentValue : auParamInfo.defaultValue;

        params.push_back(paramInfo);
    }

    return params;
}

#endif // __APPLE__

} // namespace FieldCorder
