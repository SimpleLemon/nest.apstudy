import { escapeHtml } from './utils.js';
import { renderRatingBadge } from './ratings.js';

const normalizedName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

function instructorName(instructor) {
  const name = escapeHtml(instructor.name);
  const email = String(instructor.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `<strong>${name}</strong>`;
  const href = `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}`;
  return `<a class="course-instructor-email" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(email)}">${name}</a>`;
}

function renderCourseInstructors(section) {
  const ratings = Array.isArray(section.professor_ratings) ? section.professor_ratings.filter(Boolean) : [];
  const source = Array.isArray(section.instructors) && section.instructors.length ? section.instructors
    : [{ name: section.instructor || section.instructor_name || ratings[0]?.name || 'TBA' }];
  const rows = source.map((person) => typeof person === 'string' ? { name: person } : person)
    .filter((person) => typeof person?.name === 'string' && person.name.trim()).map((person, index) => {
      const rating = ratings.find((entry) => normalizedName(entry.name) === normalizedName(person.name))
        || { name: person.name, status: 'unavailable' };
      const badge = /^(staff|tba|to be announced)$/i.test(person.name.trim()) ? '' : renderRatingBadge(rating, index);
      return `<span class="course-instructor course-rating">${instructorName(person)}${badge}</span>`;
    }).join('');
  return `<div class="course-instructors">${rows || '<strong>TBA</strong>'}</div>`;
}

export { renderCourseInstructors };
