import { createMusicLayout } from './music-layout.js';

export function createMusicRuntime({ elements, savePreferences } = {}) {
  const layout = createMusicLayout({ elements, savePreferences });
  let player = null;
  let playerModulePromise = null;
  let disposed = false;
  let activation = null;
  let latestSource = null;

  function cancelActivation() {
    activation?.removeAbort?.();
    activation?.controller.abort();
    activation = null;
  }

  const isCurrent = (operation) => !disposed && activation === operation && !operation.controller.signal.aborted;

  async function ensurePlayer(operation) {
    if (!isCurrent(operation)) return null;
    if (player) return player;
    playerModulePromise ||= import('./music-player.js');
    const { createMusicPlayer } = await playerModulePromise;
    if (!isCurrent(operation)) return null;
    player ||= createMusicPlayer(elements.playerHost);
    return player;
  }

  async function activate(source, { autoplay = false, signal } = {}) {
    if (!source?.spotify_url || disposed || signal?.aborted) return false;
    cancelActivation();
    latestSource = source;
    const operation = { controller: new AbortController() };
    activation = operation;
    const abort = () => {
      operation.controller.abort();
      if (activation === operation) player?.pause();
    };
    operation.removeAbort = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const activePlayer = await ensurePlayer(operation);
      if (!activePlayer || !isCurrent(operation)) return false;
      if (autoplay) activePlayer.resume();
      const loaded = await activePlayer.load(
        source.spotify_url,
        source.embed_url || source.spotify_embed_url,
        { signal: operation.controller.signal },
      );
      if (!isCurrent(operation)) return false;
      if (autoplay && loaded) activePlayer.resume();
      return loaded;
    } catch (error) {
      if (isCurrent(operation)) throw error;
      return false;
    } finally {
      if (!isCurrent(operation)) operation.removeAbort();
    }
  }

  function clear() {
    cancelActivation();
    latestSource = null;
    player?.clear();
  }

  function pause() {
    cancelActivation();
    player?.pause();
  }

  function resume() {
    if (disposed) return false;
    if (player?.currentUrl && player.currentUrl === latestSource?.spotify_url) {
      player.resume();
      return true;
    }
    return latestSource ? activate(latestSource, { autoplay: true }) : false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelActivation();
    latestSource = null;
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
