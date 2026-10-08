import { initializeSettingsPage } from './page.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void initializeSettingsPage(), { once: true });
} else {
  void initializeSettingsPage();
}
