import { App } from './ui/App';
import { createTauriAPI } from './utils/TauriAPI';
import './styles/main.css';

// Initialize Tauri API adapter and mount globally
window.appAPI = createTauriAPI();

// Prevent default drag-drop navigation (replaces entire app with file content)
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Global error handlers — prevent blank screen on uncaught exceptions
window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
  const el = document.getElementById('fileInfo');
  if (el) el.textContent = 'Error: ' + (event.error?.message || 'Unknown error');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  const el = document.getElementById('fileInfo');
  if (el) el.textContent = 'Error: ' + (event.reason?.message || 'Operation failed');
});

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();

  // Expose for debugging
  (window as any).app = app;

  console.log('FieldCorder DAW initialized');
  console.log('Platform:', window.appAPI?.platform || 'browser');
  console.log('Multi-channel support: 1-6 channels');
  console.log('Audio effects: Web Audio API built-in');
});
