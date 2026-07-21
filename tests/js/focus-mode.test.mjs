import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function importSource(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('focus break suggestions are optional, evidence-based, and personalized', async () => {
  const { suggestedBreaks } = await importSource('static/js/focus/data.js');
  assert.deepEqual(suggestedBreaks(8), []);
  assert.deepEqual(suggestedBreaks(12), [3, 5]);
  assert.deepEqual(suggestedBreaks(24), [6, 5]);
  assert.deepEqual(suggestedBreaks(25), [5]);
  assert.deepEqual(suggestedBreaks(50, [{ focus_minutes: 50, break_minutes: 8 }]), [8, 10]);
});

test('focus Spotify links normalize safely for setup and live sessions', async () => {
  const { normalizeSpotifyPlaylist, spotifyEmbedUrl } = await importSource('static/js/focus/data.js');
  assert.equal(normalizeSpotifyPlaylist('https://open.spotify.com/playlist/abc123?si=demo'), 'https://open.spotify.com/playlist/abc123');
  assert.match(spotifyEmbedUrl('https://open.spotify.com/playlist/abc123'), /\/embed\/playlist\/abc123/);
  assert.equal(normalizeSpotifyPlaylist('https://example.com/playlist/abc123'), '');
});

test('focus timer formatting and progress use stable timestamp math', async () => {
  const timer = await importSource('static/js/focus/timer.js');
  assert.equal(timer.formatTimer(1500), '25:00');
  assert.equal(timer.formatTimer(3661), '1:01:01');
  assert.equal(timer.progressRatio({ phase_duration_seconds: 100 }, 25), 0.75);
  assert.equal(timer.nextPhaseLabel({
    phase: 'focus', completed_focus_cycles: 0, total_cycles: 4,
    break_seconds: 300, long_break_seconds: 900,
  }), 'Break next · 5 min');
});

test('focus page keeps resource-light and accessibility contracts wired', async () => {
  const template = await readFile(path.join(repoRoot, 'templates/focus.html'), 'utf8');
  const styles = await readFile(path.join(repoRoot, 'static/css/focus.css'), 'utf8');
  const controller = await readFile(path.join(repoRoot, 'static/js/focus/index.js'), 'utf8');
  const service = await readFile(path.join(repoRoot, 'services/focus_mode.py'), 'utf8');
  const notifications = await readFile(path.join(repoRoot, 'static/js/core/notifications.js'), 'utf8');
  const navbar = await readFile(path.join(repoRoot, 'static/js/core/navbar.js'), 'utf8');
  assert.match(template, /data-focus-break-suggestions aria-live="polite"/);
  assert.match(template, /loading="lazy"/);
  assert.match(template, /<details class="focus-options">/);
  assert.match(template, /aria-label="Open focus settings"/);
  assert.match(template, /<strong>Advanced settings<\/strong>/);
  assert.match(template, /id="focus-volume"[^>]+value="100"/);
  assert.match(template, /class="focus-help"[^>]+data-tooltip="How long you will work before the timer moves to a break\."/);
  assert.match(template, /data-tooltip="Choose whether Spotify sits below the timer, beside it, or in a floating corner\."/);
  assert.match(template, /data-focus-egg/);
  assert.match(template, /data-focus-egg-result/);
  assert.match(template, /value="right-large"/);
  assert.match(template, /Set a focus timer/);
  assert.doesNotMatch(template, /left_panel_open|play_arrow|logout/);
  assert.doesNotMatch(template, /data-focus-reopen-sidebar|data-focus-prepare-next/);
  assert.match(template, /allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"/);
  assert.match(template, /data-focus-spotify-panel-url/);
  assert.match(template, /data-focus-spotify-panel-apply/);
  assert.match(styles, /\.focus-egg\[data-egg-state="open"\] \.focus-egg-half,[\s\S]*?\.focus-egg-crack\s*\{[\s\S]*?opacity: 0;/);
  assert.match(styles, /\.focus-spotify-panel-form/);
  assert.match(controller, /phase changes|focusApi\.updateSession|scheduleTick/);
  assert.match(controller, /applyLivePlaylist\(elements\.spotifyPanelUrl\)/);
  assert.match(controller, /shellActive/);
  assert.match(controller, /hideSidebarForFocus/);
  assert.match(controller, /sessionActionInFlight/);
  assert.match(controller, /duration: 3500/);
  assert.match(controller, /if \(document\.hidden\) tick\(\)/);
  assert.doesNotMatch(controller, /state\.session\.state !== 'running' \|\| document\.hidden/);
  assert.doesNotMatch(controller, /setInterval/);
  assert.match(notifications, /focus_mode_active/);
  assert.match(navbar, /focusSidebarWasCollapsed/);
  assert.match(service, /state IN \('running','paused'\)/);
  assert.match(styles, /\.focus-help:hover::after,[\s\S]*?\.focus-help:focus::after/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?data-spotify-layout/);
});
