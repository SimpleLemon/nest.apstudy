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

test('focus playlist links normalize safely for Spotify, YouTube, and YouTube Music', async () => {
  const { normalizeSpotifyPlaylist, normalizePlaylist, playlistEmbedUrl, playlistProvider, spotifyEmbedUrl } = await importSource('static/js/focus/data.js');
  assert.equal(normalizeSpotifyPlaylist('https://open.spotify.com/playlist/abc123?si=demo'), 'https://open.spotify.com/playlist/abc123');
  assert.match(spotifyEmbedUrl('https://open.spotify.com/playlist/abc123'), /\/embed\/playlist\/abc123/);
  assert.equal(
    normalizePlaylist('https://youtuBE.com/watch?v=nope'),
    '',
  );
  assert.equal(
    normalizePlaylist('https://www.youtube.com/playlist?list=PL1234567890abc&feature=share'),
    'https://www.youtube.com/playlist?list=PL1234567890abc',
  );
  assert.equal(playlistProvider('https://music.youtube.com/playlist?list=PLabcdefghijk'), 'youtube_music');
  assert.match(playlistEmbedUrl('https://www.youtube.com/playlist?list=PL1234567890abc'), /youtube-nocookie\.com\/embed\/videoseries/);
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
  assert.equal(timer.nestStage(0), 0);
  assert.equal(timer.nestStage(0.5), 4);
  assert.equal(timer.nestStage(0.92), 8);
  assert.equal(timer.eggCrackLevel(0.69), 0);
  assert.equal(timer.eggCrackLevel(0.94), 3);
});

test('focus page keeps resource-light and accessibility contracts wired', async () => {
  const template = await readFile(path.join(repoRoot, 'templates/focus.html'), 'utf8');
  const styles = await readFile(path.join(repoRoot, 'static/css/focus.css'), 'utf8');
  const lazyStyles = await readFile(path.join(repoRoot, 'static/css/focus-lazy.css'), 'utf8');
  const controller = await readFile(path.join(repoRoot, 'static/js/focus/index.js'), 'utf8');
  const view = await readFile(path.join(repoRoot, 'static/js/focus/view.js'), 'utf8');
  const musicRuntime = await readFile(path.join(repoRoot, 'static/js/focus/music-runtime.js'), 'utf8');
  const spotifyPlayer = await readFile(path.join(repoRoot, 'static/js/focus/spotify-player.js'), 'utf8');
  const completion = await readFile(path.join(repoRoot, 'static/js/focus/completion.js'), 'utf8');
  const service = await readFile(path.join(repoRoot, 'services/focus_mode.py'), 'utf8');
  const blueprint = await readFile(path.join(repoRoot, 'blueprints/focus.py'), 'utf8');
  const notifications = await readFile(path.join(repoRoot, 'static/js/core/notifications.js'), 'utf8');
  const navbar = await readFile(path.join(repoRoot, 'static/js/core/navbar.js'), 'utf8');
  assert.match(template, /data-focus-break-suggestions aria-live="polite"/);
  assert.match(spotifyPlayer, /loading = 'lazy'/);
  assert.match(template, /<dialog class="focus-options-dialog"[^>]+data-focus-options/);
  assert.match(template, />Session settings<\/span>/);
  assert.match(template, /data-focus-active-summary/);
  assert.match(template, /data-focus-inactive-settings/);
  assert.doesNotMatch(template, /Advanced settings|focus-volume|focus-help|data-tooltip/);
  assert.doesNotMatch(template, /<button\b[^>]*\btitle=/);
  assert.match(template, /data-focus-egg/);
  assert.match(template, /data-focus-egg-result/);
  assert.equal((template.match(/class="focus-nest-branch /g) || []).length, 8);
  assert.match(template, /value="below"/);
  assert.match(template, /value="beside"/);
  assert.match(template, /value="floating"/);
  assert.match(template, /<h1 id="focus-setup-title">Set a focus timer<\/h1>/);
  assert.doesNotMatch(template, /id="focus-page-title"|id="focus-page-subtitle"/);
  assert.doesNotMatch(template, /left_panel_open|play_arrow|logout/);
  assert.doesNotMatch(template, /data-focus-reopen-sidebar|data-focus-prepare-next/);
  assert.match(spotifyPlayer, /autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture/);
  assert.equal((template.match(/id="focus-spotify-url"/g) || []).length, 1);
  assert.match(template, /data-focus-playlist-apply hidden disabled/);
  assert.match(template, /data-focus-playlist-remove hidden/);
  assert.match(template, /data-focus-playlist-toggle/);
  assert.match(template, /data-focus-active-playlist-url/);
  assert.match(template, /data-focus-player-frame/);
  assert.match(template, /data-focus-panel-resize/);
  assert.match(template, />Music<\/h2>/);
  assert.match(template, /YouTube Music playlist/);
  assert.match(template, /data-focus-save-context/);
  assert.doesNotMatch(template, />bookmark_add<\/span>/);
  assert.match(template, /data-focus-exit-label/);
  assert.match(template, /data-focus-history-region hidden/);
  assert.doesNotMatch(template, /css\/tailwind\.css/);
  assert.match(styles, /\.focus-options-dialog::backdrop/);
  assert.match(styles, /\.focus-egg\[data-nest-stage="8"\] \.focus-nest-branch/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.focus-panel-resize-handle/);
  assert.match(styles, /data-spotify-custom-size/);
  assert.match(lazyStyles, /focus-player-placeholder/);
  assert.match(view, /import\('\.\/music-runtime\.js'\)/);
  assert.match(view, /import\('\.\/history-view\.js'\)/);
  assert.match(view, /import\('\.\/settings-panel\.js'\)/);
  assert.match(musicRuntime, /import\('\.\/spotify-player\.js'\)/);
  assert.doesNotMatch(controller, /^import .*completion\.js/m);
  assert.doesNotMatch(controller, /^import .*playlist-gestures\.js/m);
  assert.match(controller, /phase changes|focusApi\.updateSession|scheduleTick/);
  assert.match(controller, /focusApi\.setPlaylist/);
  assert.match(controller, /restorePlaylist/);
  assert.match(controller, /Changes saved to/);
  assert.match(controller, /view\.openOptions/);
  assert.match(controller, /shellActive/);
  assert.match(controller, /hideSidebarForFocus/);
  assert.match(controller, /sessionActionInFlight/);
  assert.match(controller, /duration = 3500/);
  assert.match(controller, /playlistToast[\s\S]*?1000/);
  assert.match(controller, /completedSession/);
  assert.match(spotifyPlayer, /controller\?\.pause|controller\.pause/);
  assert.match(spotifyPlayer, /controller\?\.resume|controller\.resume/);
  assert.match(completion, /showNotification|new Notification/);
  assert.match(completion, /playPianoCue/);
  assert.match(controller, /if \(document\.hidden\) tick\(\)/);
  assert.doesNotMatch(controller, /state\.session\.state !== 'running' \|\| document\.hidden/);
  assert.doesNotMatch(controller, /setInterval/);
  assert.match(notifications, /focus_mode_active/);
  assert.match(navbar, /focusSidebarWasCollapsed/);
  assert.match(service, /state IN \('running','paused'\)/);
  assert.match(service, /action == "set_playlist"/);
  assert.match(service, /action == "restore_playlist"/);
  assert.match(blueprint, /private, no-store, no-transform/);
  assert.doesNotMatch(styles, /focus-setup-options-open|focus-help/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?data-spotify-layout/);
});
