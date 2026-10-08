const SDK_SRC = 'https://open.spotify.com/embed/iframe-api/v1';
const API_STATE_KEY = '__apstudySpotifyIframeApi';

function loadSpotifyApi() {
  if (window[API_STATE_KEY]?.api) return Promise.resolve(window[API_STATE_KEY].api);
  if (window[API_STATE_KEY]?.promise) return window[API_STATE_KEY].promise;
  const state = window[API_STATE_KEY] || {};
  state.promise = new Promise((resolve) => {
    let settled = false;
    const finish = (api) => {
      if (api) state.api = api;
      if (settled) return;
      settled = true;
      resolve(api || null);
    };
    const previousReady = window.onSpotifyIframeApiReady;
    window.onSpotifyIframeApiReady = (api) => {
      previousReady?.(api);
      finish(api);
    };
    const existing = document.querySelector(`script[src="${SDK_SRC}"]`);
    if (!existing) {
      const script = document.createElement('script');
      script.src = SDK_SRC;
      script.async = true;
      script.dataset.focusSpotifySdk = 'true';
      script.addEventListener('error', () => finish(null), { once: true });
      document.head.appendChild(script);
    }
    window.setTimeout(() => finish(null), 5000);
  });
  window[API_STATE_KEY] = state;
  return state.promise;
}

function fallbackEmbed(host, embedUrl, provider = 'spotify') {
  if (host.querySelector('iframe')) return host.querySelector('iframe');
  const iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.title = `${provider === 'spotify' ? 'Spotify' : 'YouTube'} playlist player`;
  iframe.loading = 'eager';
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  host.replaceChildren(iframe);
  normalizeEmbedFrame(host);
  return iframe;
}

function normalizeEmbedFrame(host) {
  const iframe = host?.querySelector('iframe');
  if (!iframe) return;
  // Spotify's embed may set allowfullscreen alongside allow="...fullscreen...",
  // which triggers a console precedence warning. Keep allow and drop the legacy attr.
  if (iframe.hasAttribute('allowfullscreen')) iframe.removeAttribute('allowfullscreen');
  if (iframe.hasAttribute('allowFullscreen')) iframe.removeAttribute('allowFullscreen');
}

export function createMusicPlayer(host) {
  let controller = null;
  let currentUrl = '';
  let loadingUrl = '';
  let resumeWhenReady = false;
  let generation = 0;
  let disposed = false;
  let loadPromise = null;
  let cancelPendingLoad = null;

  function destroyController() {
    controller?.destroy?.();
    controller = null;
    host?.replaceChildren();
  }

  async function load(playlistUrl, embedUrl, { signal } = {}) {
    if (!host || disposed || !playlistUrl || signal?.aborted) return false;
    if (playlistUrl === currentUrl) return true;
    if (playlistUrl === loadingUrl) return loadPromise;
    cancelPendingLoad?.();
    const requestGeneration = ++generation;
    const cancelled = () => disposed || signal?.aborted || requestGeneration !== generation || loadingUrl !== playlistUrl;
    const abort = () => {
      if (requestGeneration === generation && loadingUrl === playlistUrl) clear();
    };
    signal?.addEventListener('abort', abort, { once: true });
    loadingUrl = playlistUrl;
    host.hidden = false;
    const provider = new URL(playlistUrl).hostname === 'open.spotify.com' ? 'spotify' : 'youtube';
    if (provider !== 'spotify') {
      destroyController();
      fallbackEmbed(host, embedUrl, provider);
      currentUrl = playlistUrl;
      loadingUrl = '';
      signal?.removeEventListener('abort', abort);
      return true;
    }
    loadPromise = (async () => {
      let cancelSdk;
      const sdkCancelled = new Promise((resolve) => {
        cancelSdk = () => {
          if (cancelPendingLoad === cancelSdk) cancelPendingLoad = null;
          resolve(null);
        };
        cancelPendingLoad = cancelSdk;
      });
      const api = await Promise.race([loadSpotifyApi(), sdkCancelled]);
      if (cancelPendingLoad === cancelSdk) cancelPendingLoad = null;
      if (cancelled()) return false;
      destroyController();
      if (!api?.createController) {
        fallbackEmbed(host, embedUrl, provider);
        currentUrl = playlistUrl;
        loadingUrl = '';
        return true;
      }
      const mount = document.createElement('div');
      mount.className = 'focus-spotify-controller';
      host.replaceChildren(mount);
      return new Promise((resolve) => {
        const finish = (loaded) => {
          if (cancelPendingLoad === cancel) cancelPendingLoad = null;
          resolve(loaded);
        };
        const cancel = () => {
          window.clearTimeout(controllerTimeout);
          finish(false);
        };
        const controllerTimeout = window.setTimeout(() => {
          if (cancelled()) {
            finish(false);
            return;
          }
          fallbackEmbed(host, embedUrl, provider);
          currentUrl = playlistUrl;
          loadingUrl = '';
          finish(true);
        }, 5000);
        cancelPendingLoad = cancel;
        api.createController(mount, { url: playlistUrl, width: '100%', height: 352 }, (nextController) => {
          window.clearTimeout(controllerTimeout);
          if (cancelled()) {
            nextController.destroy?.();
            finish(false);
            return;
          }
          controller = nextController;
          currentUrl = playlistUrl;
          loadingUrl = '';
          normalizeEmbedFrame(host);
          if (resumeWhenReady) controller.resume?.();
          finish(true);
        });
      });
    })().finally(() => {
      signal?.removeEventListener('abort', abort);
      if (requestGeneration === generation) {
        cancelPendingLoad = null;
        if (loadingUrl === playlistUrl) loadingUrl = '';
      }
    });
    return loadPromise;
  }

  function clear() {
    generation += 1;
    cancelPendingLoad?.();
    destroyController();
    resumeWhenReady = false;
    currentUrl = '';
    loadingUrl = '';
    loadPromise = null;
    if (host) host.hidden = true;
  }

  function pause() {
    resumeWhenReady = false;
    controller?.pause?.();
    host?.querySelector('iframe')?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
  }

  function resume() {
    resumeWhenReady = true;
    controller?.resume?.();
    host?.querySelector('iframe')?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
  }

  function dispose() {
    disposed = true;
    resumeWhenReady = false;
    clear();
  }

  return { clear, dispose, load, pause, resume, get currentUrl() { return currentUrl; } };
}
