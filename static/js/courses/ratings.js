import { escapeHtml, formatCourseCardSchedule, normalizeScheduleDisplay } from './utils.js';

const STATUS_TEXT = {
  unmatched: 'No matching profile',
  ambiguous: 'Profile match uncertain',
  unrated: 'No ratings yet',
  unavailable: 'Ratings unavailable',
};

function ratingNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 5 ? number.toFixed(1) : null;
}

function safeRatingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['ratemyprofessors.com', 'www.ratemyprofessors.com'].includes(url.hostname)
      && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function ratingSummary(rating) {
  const score = ratingScore(rating);
  if (score !== null) return `${score}/5`;
  return rating.status === 'unrated' || hasZeroRatings(rating) ? 'No ratings yet'
    : STATUS_TEXT[rating.status] || 'Ratings unavailable';
}

function ratingDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function safeProfileUrl(value) {
  const href = safeRatingUrl(value);
  return href && /^\/professor\/[1-9]\d{0,11}\/?$/.test(new URL(href).pathname) ? href : '';
}

function hasZeroRatings(rating) {
  const count = rating.rating_count;
  return (typeof count === 'number' || typeof count === 'string') && String(count).trim() !== '' && Number(count) === 0;
}

function ratingScore(rating) {
  const score = ratingNumber(rating.overall_rating);
  return ['matched', 'unavailable'].includes(rating.status) && safeProfileUrl(rating.profile_url)
    && score !== null && Number(rating.overall_rating) >= 1 && !hasZeroRatings(rating) ? score : null;
}

function ratingCountText(rating) {
  const count = rating.rating_count;
  return (typeof count === 'number' || typeof count === 'string') && String(count).trim() !== '' && Number.isInteger(Number(count)) && Number(count) >= 0
    ? `${Number(count).toLocaleString()} ${Number(count) === 1 ? 'rating' : 'ratings'}` : '';
}

function renderRatingBadge(rating, index) {
  const score = ratingScore(rating);
  // RMP's public quality cards use green >= 4, yellow >= 3, and red < 3.
  const tone = score === null ? 'unrated' : Number(rating.overall_rating) >= 4 ? 'green'
    : Number(rating.overall_rating) >= 3 ? 'yellow' : 'red';
  const profile = ['matched', 'unrated', 'unavailable'].includes(rating.status) && safeProfileUrl(rating.profile_url);
  const search = safeRatingUrl(rating.search_url);
  const href = profile || (search && /^\/search\/professors\/(?:0|[1-9]\d{0,11})\/?$/.test(new URL(search).pathname) ? search : '');
  const name = rating.name || 'instructor';
  const updated = ratingDate(rating.fetched_at);
  const details = [score === null ? ratingSummary(rating) : `${score} out of 5`, ratingCountText(rating),
    rating.stale ? 'Older saved rating' : '', updated ? `Updated ${updated}` : ''].filter(Boolean).join(' · ');
  const label = `${name}: ${details}${href ? `. ${profile ? 'View profile' : 'Search'} on Rate My Professors (opens in a new tab)` : ''}`;
  const attributes = `class="course-rating-badge is-${tone}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"`;
  return href
    ? `<a ${attributes} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-professor-rating-link="${index}">${score ?? '–'}</a>`
    : `<span ${attributes} role="img">${score ?? '–'}</span>`;
}

function sectionRatings(section) {
  const ratings = Array.isArray(section?.professor_ratings) ? section.professor_ratings.filter(rating => rating && typeof rating === 'object') : [];
  if (ratings.length) return ratings;
  const instructors = Array.isArray(section?.instructors) && section.instructors.length
    ? section.instructors.map(instructor => instructor?.name) : [section?.instructor || section?.instructor_name];
  return [...new Set(instructors.filter(name => typeof name === 'string' && name.trim()
    && !/^(staff|tba|to be announced)$/i.test(name.trim())).map(name => name.trim()))]
    .map(name => ({ name, status: 'unavailable' }));
}

function renderProfessorRatings(section, { compact = false } = {}) {
  const ratings = sectionRatings(section);
  if (!ratings.length) return '';
  const edited = Boolean(section.overrides?.instructor || section.overrides?.instructor_name);
  const rows = ratings.map((rating, index) => {
    const countText = ratingCountText(rating);
    const difficulty = ratingNumber(rating.difficulty);
    const updated = ratingDate(rating.fetched_at);
    const detail = compact ? '' : `<span class="course-rating-detail">${[
      countText, difficulty === null ? 'Difficulty unavailable' : `Difficulty ${difficulty}/5`,
      updated ? `Updated ${updated}` : 'Update date unavailable',
      rating.stale ? 'Older saved rating' : '',
    ].filter(Boolean).map(escapeHtml).join(' · ')}</span>`;
    const displayName = compact && edited && ratings.length === 1
      ? section.instructor || section.instructor_name : rating.name;
    const name = `<strong>${escapeHtml(displayName || 'Instructor')}</strong>`;
    return compact
      ? `<span class="course-rating">${name}${renderRatingBadge(rating, index)}</span>`
      : `<div class="course-rating"><span class="course-rating-heading">${name}${renderRatingBadge(rating, index)}</span>${detail}</div>`;
  }).join('');
  return `<section class="course-professor-ratings ${compact ? 'is-compact' : ''}" aria-label="Professor ratings from Rate My Professors">${compact ? '' : '<h3>Professor ratings</h3>'}${edited ? '<p class="course-rating-note">Ratings refer to Atlas instructors; your instructor label is customized.</p>' : ''}${rows}${compact ? '' : '<p class="course-rating-note">Source: Rate My Professors. Saved ratings are separate from live seat availability.</p>'}</section>`;
}

function renderCourseCardSchedule(section) {
  const ratings = renderProfessorRatings(section, { compact: true });
  if (!ratings) return escapeHtml(formatCourseCardSchedule(section));
  const schedule = normalizeScheduleDisplay(section.schedule_display || '').trim();
  return `${schedule ? `<span>${escapeHtml(schedule)}</span><span aria-hidden="true">|</span>` : ''}${ratings}`;
}

export { renderProfessorRatings, renderCourseCardSchedule, renderRatingBadge, safeRatingUrl, ratingSummary };
