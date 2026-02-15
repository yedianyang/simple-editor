import { App } from './ui/App';
import './styles/main.css';

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();

  // Expose for debugging
  (window as any).app = app;

  console.log('FieldCorder DAW initialized');
  console.log('Platform:', window.electronAPI?.platform || 'browser');
  console.log('Multi-channel support: 1-6 channels');
  console.log('VST/AU plugin hosting:', window.electronAPI ? 'available' : 'Web Audio fallback');
});
