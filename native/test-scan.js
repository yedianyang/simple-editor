#!/usr/bin/env node
/**
 * Test script: Verify native addon loads and AU plugin scanning works.
 * Run with: node native/test-scan.js
 */

try {
  const addon = require('./build/Release/fieldcorder_native.node');
  console.log('Native addon loaded successfully!\n');

  // Test scanPlugins
  console.log('Scanning AudioUnit plugins...\n');
  const plugins = addon.scanPlugins();

  if (!Array.isArray(plugins)) {
    console.error('ERROR: scanPlugins() did not return an array:', plugins);
    process.exit(1);
  }

  console.log(`Found ${plugins.length} AudioUnit plugins:\n`);

  // Group by category
  const byCategory = {};
  for (const p of plugins) {
    const cat = p.category || 'unknown';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  for (const [category, items] of Object.entries(byCategory)) {
    console.log(`--- ${category} (${items.length}) ---`);
    for (const p of items.slice(0, 5)) {
      console.log(`  ${p.name}  [${p.id}]  vendor: ${p.vendor}`);
    }
    if (items.length > 5) {
      console.log(`  ... and ${items.length - 5} more`);
    }
    console.log('');
  }

  // Test getAudioDevices if available
  if (addon.getAudioDevices) {
    console.log('Audio devices:');
    const devices = addon.getAudioDevices();
    for (const d of devices) {
      console.log(`  ${d.name} (in: ${d.inputChannels}, out: ${d.outputChannels}, ${d.sampleRate}Hz)`);
    }
  }

  console.log('\nAll tests passed!');
} catch (err) {
  console.error('Failed to load native addon:', err.message);
  console.error(err.stack);
  process.exit(1);
}
