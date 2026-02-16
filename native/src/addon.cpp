/**
 * FieldCorder Native Addon
 *
 * Provides native AudioUnit plugin hosting and Core Audio device access
 * for the FieldCorder DAW. This is the N-API entry point.
 *
 * Build requirements:
 *   - node-addon-api
 *   - cmake-js
 *   - macOS SDK (for AudioUnit/CoreAudio)
 *   - VST3 SDK (optional, for VST3 plugin hosting)
 */

#include <napi.h>
#include "plugin_host.h"

#ifdef __APPLE__
#include "audio_device.h"
#endif

// Global plugin host instance
static FieldCorder::PluginHost* g_pluginHost = nullptr;

static FieldCorder::PluginHost* getPluginHost() {
    if (!g_pluginHost) {
        g_pluginHost = new FieldCorder::PluginHost();
    }
    return g_pluginHost;
}

// ==================== Scan Plugins ====================

Napi::Value ScanPlugins(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto host = getPluginHost();
    auto plugins = host->scanAudioUnits();

    Napi::Array result = Napi::Array::New(env, plugins.size());
    for (size_t i = 0; i < plugins.size(); i++) {
        Napi::Object item = Napi::Object::New(env);
        item.Set("id", Napi::String::New(env, plugins[i].id));
        item.Set("name", Napi::String::New(env, plugins[i].name));
        item.Set("category", Napi::String::New(env, plugins[i].category));
        item.Set("format", Napi::String::New(env, plugins[i].format));
        item.Set("vendor", Napi::String::New(env, plugins[i].vendor));
        result[i] = item;
    }

    return result;
}

// ==================== Load Plugin ====================

Napi::Value LoadPlugin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Plugin identifier (string) expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string identifier = info[0].As<Napi::String>().Utf8Value();
    auto host = getPluginHost();
    auto result = host->loadPlugin(identifier);

    Napi::Object obj = Napi::Object::New(env);
    if (result.success) {
        obj.Set("id", Napi::String::New(env, result.pluginId));
        obj.Set("name", Napi::String::New(env, result.name));

        Napi::Array params = Napi::Array::New(env, result.parameters.size());
        for (size_t i = 0; i < result.parameters.size(); i++) {
            Napi::Object param = Napi::Object::New(env);
            param.Set("id", Napi::Number::New(env, result.parameters[i].id));
            param.Set("name", Napi::String::New(env, result.parameters[i].name));
            param.Set("value", Napi::Number::New(env, result.parameters[i].value));
            param.Set("min", Napi::Number::New(env, result.parameters[i].min));
            param.Set("max", Napi::Number::New(env, result.parameters[i].max));
            param.Set("defaultValue", Napi::Number::New(env, result.parameters[i].defaultValue));
            params[i] = param;
        }
        obj.Set("parameters", params);
    } else {
        obj.Set("error", Napi::String::New(env, result.errorMessage));
    }

    return obj;
}

// ==================== Process Audio ====================

Napi::Value ProcessAudio(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsArray() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected (pluginId, audioChannels[], sampleRate)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    auto host = getPluginHost();
    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    Napi::Array channels = info[1].As<Napi::Array>();
    double sampleRate = info[2].As<Napi::Number>().DoubleValue();

    uint32_t numChannels = channels.Length();
    if (numChannels == 0) return env.Null();

    // Get the first channel to determine buffer size
    Napi::Float32Array firstChannel = channels.Get(static_cast<uint32_t>(0))
                                          .As<Napi::Float32Array>();
    int numSamples = static_cast<int>(firstChannel.ElementLength());

    // Set up input/output buffer pointers
    std::vector<float*> inputPtrs(numChannels);
    std::vector<std::vector<float>> outputBuffers(numChannels);
    std::vector<float*> outputPtrs(numChannels);

    for (uint32_t ch = 0; ch < numChannels; ch++) {
        Napi::Float32Array channelData = channels.Get(ch).As<Napi::Float32Array>();
        inputPtrs[ch] = channelData.Data();

        outputBuffers[ch].resize(numSamples);
        outputPtrs[ch] = outputBuffers[ch].data();
    }

    // Process through the plugin
    host->processAudio(pluginId, inputPtrs.data(), outputPtrs.data(),
                       static_cast<int>(numChannels), numSamples, sampleRate);

    // Return processed audio as array of Float32Arrays
    Napi::Array result = Napi::Array::New(env, numChannels);
    for (uint32_t ch = 0; ch < numChannels; ch++) {
        Napi::Float32Array outputChannel = Napi::Float32Array::New(env, numSamples);
        std::memcpy(outputChannel.Data(), outputPtrs[ch], numSamples * sizeof(float));
        result[ch] = outputChannel;
    }

    return result;
}

// ==================== Parameters ====================

Napi::Value GetParameters(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Null();
    }

    auto host = getPluginHost();
    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    auto params = host->getParameters(pluginId);

    Napi::Array result = Napi::Array::New(env, params.size());
    for (size_t i = 0; i < params.size(); i++) {
        Napi::Object param = Napi::Object::New(env);
        param.Set("id", Napi::Number::New(env, params[i].id));
        param.Set("name", Napi::String::New(env, params[i].name));
        param.Set("value", Napi::Number::New(env, params[i].value));
        param.Set("min", Napi::Number::New(env, params[i].min));
        param.Set("max", Napi::Number::New(env, params[i].max));
        param.Set("defaultValue", Napi::Number::New(env, params[i].defaultValue));
        result[i] = param;
    }

    return result;
}

Napi::Value SetParameter(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
        return env.Null();
    }

    auto host = getPluginHost();
    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    int paramId = info[1].As<Napi::Number>().Int32Value();
    double value = info[2].As<Napi::Number>().DoubleValue();

    host->setParameter(pluginId, paramId, value);

    return env.Undefined();
}

// ==================== Unload ====================

Napi::Value UnloadPlugin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Null();
    }

    auto host = getPluginHost();
    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    host->unloadPlugin(pluginId);

    return env.Undefined();
}

// ==================== Audio Devices ====================

#ifdef __APPLE__
Napi::Value GetAudioDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto devices = FieldCorder::AudioDevice::getDevices();

    Napi::Array result = Napi::Array::New(env, devices.size());
    for (size_t i = 0; i < devices.size(); i++) {
        Napi::Object device = Napi::Object::New(env);
        device.Set("id", Napi::Number::New(env, devices[i].id));
        device.Set("name", Napi::String::New(env, devices[i].name));
        device.Set("inputChannels", Napi::Number::New(env, devices[i].inputChannels));
        device.Set("outputChannels", Napi::Number::New(env, devices[i].outputChannels));
        device.Set("sampleRate", Napi::Number::New(env, devices[i].sampleRate));
        result[i] = device;
    }

    return result;
}
#endif

// ==================== Module Init ====================

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("scanPlugins", Napi::Function::New(env, ScanPlugins));
    exports.Set("loadPlugin", Napi::Function::New(env, LoadPlugin));
    exports.Set("processAudio", Napi::Function::New(env, ProcessAudio));
    exports.Set("getParameters", Napi::Function::New(env, GetParameters));
    exports.Set("setParameter", Napi::Function::New(env, SetParameter));
    exports.Set("unloadPlugin", Napi::Function::New(env, UnloadPlugin));

#ifdef __APPLE__
    exports.Set("getAudioDevices", Napi::Function::New(env, GetAudioDevices));
#endif

    return exports;
}

NODE_API_MODULE(fieldcorder_native, Init)
