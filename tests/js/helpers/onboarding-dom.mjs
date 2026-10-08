import { createSettingsDOM } from './settings-dom.mjs';

// Public wizard controls, with the same ids, stage attributes and radio values
// as onboarding.html. The real entry module installs every tested listener.
export function createOnboardingDOM({ emoryStudent = false } = {}) {
  const { window } = createSettingsDOM('https://nest.example/onboarding');
  const document = window.document;
  document.body.replaceChildren();
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  const node = (tag, attributes = {}, parent = document.body) => {
    const result = document.createElement(tag);
    Object.entries(attributes).forEach(([key, value]) => result.setAttribute(key, value));
    parent.appendChild(result);
    return result;
  };
  const form = node('form', { id: 'onboarding-form' });
  const ids = ['active-step', 'default-term', 'progress-bar', 'step-label', 'onboarding-welcome-header', 'wizard-status', 'onboarding-display-name', 'onboarding-username', 'onboarding-display-name-help', 'onboarding-username-help', 'course-search', 'course-suggestions', 'course-code', 'course-name', 'section-number', 'instructor-name', 'course-list', 'course-count', 'term-options', 'class-year-field', 'class-year', 'emory-student-field', 'emory-email-field', 'emory-email', 'university-field', 'university-school', 'university-options', 'onboarding-major', 'review-education-level', 'review-class-year', 'review-emory-student', 'review-emory-email', 'review-courses-card', 'review-courses', 'review-courses-empty', 'preferences-step-number', 'confirm-step-number', 'canvas-feed-url', 'other-calendar-count'];
  ids.forEach((id) => node('input', { id }, form));
  document.getElementById('active-step').value = '1';
  document.getElementById('default-term').value = 'Fall_2026';
  for (let step = 1; step <= 5; step += 1) {
    node('li', { 'data-onboarding-stage': step });
    const panel = node('section', { 'data-step': step, class: 'wizard-step', ...(step === 3 ? { id: 'courses-step' } : {}) }, form);
    node('h2', {}, panel);
    if (step < 5) node('button', { class: 'btn-next', 'data-next': step + 1, ...(step === 2 || step === 3 ? { id: `step-${step}-continue` } : {}) }, panel);
    if (step > 1) node('button', { class: 'btn-back', 'data-prev': step - 1 }, panel);
  }
  const education = node('div', { id: 'education-level-group' }, form);
  ['High School', 'Undergraduate', 'Graduate', 'Other'].forEach((level) => node('button', { 'data-education-level': level }, education));
  const emory = node('div', { id: 'emory-student-group' }, form);
  ['true', 'false'].forEach((value) => node('button', { 'data-emory-student': value }, emory));
  const themes = node('fieldset', { id: 'onboarding-theme-cards' }, form);
  ['obsidian-dark', 'parchment-light', 'system-match', 'nest-light', 'nest-dark'].forEach((value) => {
    const card = node('label', { class: 'theme-card' }, themes);
    const input = node('input', { 'data-theme-input': '', type: 'radio' }, card);
    input.value = value;
    node('span', { class: 'theme-check hidden' }, card);
  });
  node('div', { id: 'other-calendar-links' }, form);
  ['add-other-calendar', 'add-course-button', 'finish-button'].forEach((id) => node('button', { id }, form));
  const data = node('script', { id: 'onboarding-data' });
  data.textContent = JSON.stringify({ displayName: 'Taylor', username: 'taylor', educationLevel: 'Undergraduate', classYear: '2028', emoryStudent, emoryEmail: emoryStudent ? 'taylor@emory.edu' : '', school: emoryStudent ? 'Emory University' : 'Other University', major: 'Biology', courses: [], endpoints: { terms: '/terms', onboarding: '/onboarding', interfacePreferences: '/interface-preferences', savedCourses: '/saved-courses', feedUrl: '/feed-url', dashboard: 'https://nest.example/dashboard' } });
  return { window, document, node };
}
