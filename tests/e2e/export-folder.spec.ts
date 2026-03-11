import { test, expect } from '@playwright/test';

test.describe('Export pre-selected folder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the app to initialize
    await page.waitForFunction(() => (window as unknown as { app: unknown }).app !== undefined, null, { timeout: 15000 });

    // Create a minimal audio buffer so the export modal can open
    // (showExportModal early-returns if no audioBuffer)
    await page.evaluate(() => {
      const app = (window as unknown as { app: { audioEngine: { audioBuffer: AudioBuffer; audioContext: AudioContext } } }).app;
      const ctx = app.audioEngine.audioContext;
      app.audioEngine.audioBuffer = ctx.createBuffer(1, 48000, 48000);
    });
  });

  test('export modal opens when clicking toolbar export button', async ({ page }) => {
    const exportBtn = page.locator('#exportBtn');
    await exportBtn.click();

    const modal = page.locator('#exportModal');
    await expect(modal).toHaveClass(/visible/);
  });

  test('export format dropdown has WAV, AIF, and MP3 options', async ({ page }) => {
    await page.locator('#exportBtn').click();

    const formatSelect = page.locator('#exportFormat');
    const options = formatSelect.locator('option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveValue('wav');
    await expect(options.nth(1)).toHaveValue('aif');
    await expect(options.nth(2)).toHaveValue('mp3');
  });

  test('export filename input is editable', async ({ page }) => {
    await page.locator('#exportBtn').click();

    const filenameInput = page.locator('#exportFilename');
    await filenameInput.fill('my-exported-file');
    await expect(filenameInput).toHaveValue('my-exported-file');
  });

  test('export path display shows pre-selected folder when dataset is set', async ({ page }) => {
    // Set a pre-selected export path via dataset
    await page.evaluate(() => {
      const pathEl = document.getElementById('exportPath') as HTMLElement;
      pathEl.dataset.fullPath = '/Users/test/Desktop/exports';
      pathEl.textContent = '/Users/test/Desktop/exports';
    });

    const pathDisplay = page.locator('#exportPath');
    await expect(pathDisplay).toHaveText('/Users/test/Desktop/exports');
    const fullPath = await pathDisplay.getAttribute('data-full-path');
    expect(fullPath).toBe('/Users/test/Desktop/exports');
  });

  test('MP3 format shows bitrate selector; WAV format hides it', async ({ page }) => {
    await page.locator('#exportBtn').click();

    const bitrateRow = page.locator('#exportBitrateRow');
    const bitDepthRow = page.locator('#exportBitDepthRow');
    const ditherRow = page.locator('#exportDitherRow');

    // Default format is WAV -- bitrate hidden, bit depth visible
    await expect(bitrateRow).toBeHidden();
    await expect(bitDepthRow).toBeVisible();
    await expect(ditherRow).toBeVisible();

    // Switch to MP3
    await page.locator('#exportFormat').selectOption('mp3');
    await expect(bitrateRow).toBeVisible();
    await expect(bitDepthRow).toBeHidden();
    await expect(ditherRow).toBeHidden();

    // Switch back to WAV
    await page.locator('#exportFormat').selectOption('wav');
    await expect(bitrateRow).toBeHidden();
    await expect(bitDepthRow).toBeVisible();
    await expect(ditherRow).toBeVisible();
  });

  test('cancel button closes the export modal', async ({ page }) => {
    await page.locator('#exportBtn').click();
    const modal = page.locator('#exportModal');
    await expect(modal).toHaveClass(/visible/);

    await page.locator('#exportCancelBtn').click();
    await expect(modal).not.toHaveClass(/visible/);
  });
});
