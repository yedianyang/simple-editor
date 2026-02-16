cmake_minimum_required(VERSION 3.15)
project(fieldcorder_native)

# Require C++17
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Node.js addon
include_directories(${CMAKE_JS_INC})

# Source files
set(SOURCES
    src/addon.cpp
    src/plugin_host.cpp
)

# macOS specific sources
if(APPLE)
    list(APPEND SOURCES
        src/audio_device.mm
    )
endif()

# Create the native addon
add_library(${PROJECT_NAME} SHARED ${SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# Link libraries
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

if(APPLE)
    # macOS frameworks for audio and plugin hosting
    find_library(COREAUDIO_FRAMEWORK CoreAudio)
    find_library(AUDIOTOOLBOX_FRAMEWORK AudioToolbox)
    find_library(AUDIOUNIT_FRAMEWORK AudioUnit)
    find_library(COREFOUNDATION_FRAMEWORK CoreFoundation)
    find_library(COCOA_FRAMEWORK Cocoa)

    target_link_libraries(${PROJECT_NAME}
        ${COREAUDIO_FRAMEWORK}
        ${AUDIOTOOLBOX_FRAMEWORK}
        ${AUDIOUNIT_FRAMEWORK}
        ${COREFOUNDATION_FRAMEWORK}
        ${COCOA_FRAMEWORK}
    )

    # VST3 SDK (optional - set VST3_SDK_PATH to enable)
    if(DEFINED VST3_SDK_PATH)
        target_include_directories(${PROJECT_NAME} PRIVATE ${VST3_SDK_PATH})
        target_compile_definitions(${PROJECT_NAME} PRIVATE HAS_VST3_SDK=1)
    endif()
endif()

# Node-API — resolve from project root where node_modules lives
execute_process(COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/..
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
# Strip quotes from node output (e.g. "/path/to/dir" → /path/to/dir)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})
target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_VERSION=8)
