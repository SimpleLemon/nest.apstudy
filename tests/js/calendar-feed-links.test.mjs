import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../static/js/calendar/feed-links.js', import.meta.url), 'utf8');
const { calendarFeedComparisonKey, validateCalendarFeedLinks } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('feed comparison accepts http/https/webcal and explicit missing-scheme allowance', () => {
  assert.equal(calendarFeedComparisonKey(' webcal://CALENDAR.example/feed///?token=1#ignored '), 'https://calendar.example/feed?token=1');
  assert.equal(calendarFeedComparisonKey('https://calendar.example:443/feed/'), 'https://calendar.example/feed');
  assert.equal(calendarFeedComparisonKey('http://calendar.example/feed'), 'http://calendar.example/feed');
  assert.equal(calendarFeedComparisonKey('calendar.example/feed'), '');
  assert.equal(calendarFeedComparisonKey('calendar.example/feed', { allowMissingScheme: true }), 'https://calendar.example/feed');
  for (const url of ['', 'file:///feed', 'javascript:alert(1)', 'ftp://calendar.example/feed', 'https://']) assert.equal(calendarFeedComparisonKey(url), '');
});

test('validated feed payload retains link spelling, trims values, and ignores empty rows', () => {
  assert.deepEqual(validateCalendarFeedLinks(' canvas.example/feed ', ['', ' webcal://calendar.example/feed/ ', 'https://calendar.example/feed?token=1']), {
    canvas_ical_url: 'canvas.example/feed',
    other_ical_urls: ['webcal://calendar.example/feed/', 'https://calendar.example/feed?token=1'],
  });
});

test('feed list errors retain offending input index and keep Canvas missing-scheme policy explicit', () => {
  const check = (callback, code, inputIndex) => assert.throws(callback, error => error.code === code && error.inputIndex === inputIndex);
  check(() => validateCalendarFeedLinks('', ['', 'calendar.example/feed']), 'invalid_url', 1);
  check(() => validateCalendarFeedLinks('', ['https://calendar.example/feed/', '', 'webcal://CALENDAR.example/feed#view']), 'duplicate', 2);
  check(() => validateCalendarFeedLinks('canvas.example/feed', ['', 'webcal://canvas.example/feed'], { canvasAllowMissingScheme: true }), 'canvas_duplicate', 1);
  assert.deepEqual(validateCalendarFeedLinks('canvas.example/feed', ['webcal://canvas.example/feed']).other_ical_urls, ['webcal://canvas.example/feed']);
  check(() => validateCalendarFeedLinks('', ['', 'https://calendar.example/1', '', 'https://calendar.example/2'], { maxOtherCalendars: 1 }), 'too_many', 3);
});
