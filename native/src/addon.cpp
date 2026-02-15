/**
 * FieldCorder Native Addon
 *
 * Provides native VST3/AudioUnit plugin hosting and Core Audio device access
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

// Plugin Host wrapper
static FieldCorder::PluginHost* g_pluginHost = nullptr;

Napi::Value LoadPlugin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Plugin path expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string pluginPath = info[0].As<Napi::String>().Utf8Value();

    if (!g_pluginHost) {
        g_pluginHost = new FieldCorder::PluginHost();
    }

    auto result = g_pluginHost->loadPlugin(pluginPath);

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

Napi::Value ProcessAudio(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_pluginHost || info.Length() < 3) {
        return env.Null();
    }

    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    // Audio processing would happen here
    // For now, pass-through

    return env.Null();
}

Napi::Value GetParameters(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_pluginHost || info.Length() < 1) {
        return env.Null();
    }

    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    auto params = g_pluginHost->getParameters(pluginId);

    Napi::Array result = Napi::Array::New(env, params.size());
    for (size_t i = 0; i < params.size(); i++) {
        Napi::Object param = Napi::Object::New(env);
        param.Set("id", Napi::Number::New(env, params[i].id));
        param.Set("name", Napi::String::New(env, params[i].name));
        param.Set("value", Napi::Number::New(env, params[i].value));
        param.Set("min", Napi::Number::New(env, params[i].min));
        param.Set("max", Napi::Number::New(env, params[i].max));
        result[i] = param;
    }

    return result;
}

Napi::Value SetParameter(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_pluginHost || info.Length() < 3) {
        return env.Null();
    }

    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    int paramId = info[1].As<Napi::Number>().Int32Value();
    double value = info[2].As<Napi::Number>().DoubleValue();

    g_pluginHost->setParameter(pluginId, paramId, value);

    return env.Undefined();
}

Napi::Value UnloadPlugin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_pluginHost || info.Length() < 1) {
        return env.Null();
    }

    std::string pluginId = info[0].As<Napi::String>().Utf8Value();
    g_pluginHost->unloadPlugin(pluginId);

    return env.Undefined();
}

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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
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
