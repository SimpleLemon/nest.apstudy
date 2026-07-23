import { createSpotifyLayout } from './spotify-layout.js';

export function createMusicRuntime({ elements, savePreferences } = {}) {
  const layout = createSpotifyLayout({ elements, savePreferences });
  let player = null;
  let playerModulePromise = null;
  let disposed = false;

  async function ensurePlayer() {
    if (disposed) return null;
    if (player) return player;
    playerModulePromise ||= import('./spotify-player.js');
    const { createSpotifyPlayer } = await playerModulePromise;
    if (disposed) return null;
    player ||= createSpotifyPlayer(elements.spotifyEmbed);
    return player;
  }

  async function activate(source, { autoplay = false } = {}) {
    if (!source?.spotify_url || disposed) return false;
    const activePlayer = await ensurePlayer();
    if (!activePlayer) return false;
    if (autoplay) activePlayer.resume();
    const loaded = await activePlayer.load(
      source.spotify_url,
      source.embed_url || source.spotify_embed_url,
    );
    if (autoplay && loaded) activePlayer.resume();
    return loaded;
  }

  function clear() {
    player?.clear();
  }

  function pause() {
    player?.pause();
  }

  function resume() {
    player?.resume();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    layout.dispose();
    player?.dispose();
    player = null;
    playerModulePromise = null;
  }

  return {
    activate,
    applyPreferences: layout.applyPreferences,
    clear,
    dispose,
    pause,
    resume,
    setLayout: layout.setLayout,
  };
}
