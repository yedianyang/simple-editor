#!/bin/bash
# Build the native addon for FieldCorder DAW
# Requires: cmake, node-addon-api, cmake-js
#
# Usage:
#   ./scripts/build-native.sh                    # Build without VST3 SDK
#   VST3_SDK_PATH=/path/to/vst3sdk ./scripts/build-native.sh  # Build with VST3 support

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NATIVE_DIR="$PROJECT_DIR/native"

echo "Building FieldCorder native addon..."
echo "Native dir: $NATIVE_DIR"

# Install cmake-js if not available
if ! command -v cmake-js &> /dev/null; then
    echo "Installing cmake-js..."
    npm install -g cmake-js
fi

# Build
cd "$NATIVE_DIR"

CMAKE_ARGS=""
if [ -n "$VST3_SDK_PATH" ]; then
    echo "VST3 SDK path: $VST3_SDK_PATH"
    CMAKE_ARGS="-DVST3_SDK_PATH=$VST3_SDK_PATH"
fi

cmake-js build --directory "$NATIVE_DIR" $CMAKE_ARGS

echo "Build complete!"
echo "Output: $NATIVE_DIR/build/Release/fieldcorder_native.node"
