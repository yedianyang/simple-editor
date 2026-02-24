#!/bin/bash
# FieldCorder TDD Setup Script

echo "📦 Installing Vitest and dependencies..."
cd /Volumes/Metro-External/simple-editor

npm install -D vitest \
  @vitest/ui \
  jsdom \
  @testing-library/dom \
  @testing-library/user-event

echo "✅ Test dependencies installed"

echo "📝 Creating vitest config..."
cat > vitest.config.ts << 'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '*.config.ts',
        'src-tauri/',
      ],
    },
  },
});
EOF

echo "📁 Creating test structure..."
mkdir -p tests/unit tests/integration

cat > tests/setup.ts << 'EOF'
// Global test setup
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/dom';

// Cleanup after each test
afterEach(() => {
  cleanup();
});
EOF

cat > tests/unit/AudioEngine.test.ts << 'EOF'
import { describe, it, expect, beforeEach } from 'vitest';
// import { AudioEngine } from '../../src/core/AudioEngine';

describe('AudioEngine', () => {
  // let engine: AudioEngine;

  // beforeEach(() => {
  //   engine = new AudioEngine();
  // });

  it('should initialize audio context', () => {
    // TDD Example: Write test first (Red)
    // expect(engine.audioContext).toBeDefined();
    // expect(engine.audioContext.state).toBe('suspended');
    expect(true).toBe(true); // Placeholder
  });

  it('should load WAV file', async () => {
    // TDD: Test file import functionality
    expect(true).toBe(true); // TODO: Implement
  });
});
EOF

echo "📝 Adding npm scripts to package.json..."
# Note: This requires jq or manual editing
echo "Add these scripts to package.json manually:"
echo '  "test": "vitest",'
echo '  "test:ui": "vitest --ui",'
echo '  "test:coverage": "vitest --coverage"'

echo ""
echo "✅ TDD setup complete!"
echo ""
echo "Next steps:"
echo "1. Add test scripts to package.json"
echo "2. Run 'npm test' to start test watcher"
echo "3. Configure .clinerules for TDD workflow"
