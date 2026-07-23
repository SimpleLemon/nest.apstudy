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

export function createSpotifyPlayer(host) {
  let controller = null;
  let currentUrl = '';
  let loadingUrl = '';
  let resumeWhenReady = false;
  let generation = 0;
  let disposed = false;
  let loadPromise = null;

  function destroyController() {
    controller?.destroy?.();
    controller = null;
    host?.replaceChildren();
  }

  async function load(spotifyUrl, embedUrl) {
    if (!host || disposed || !spotifyUrl) return false;
    if (spotifyUrl === currentUrl) return true;
    if (spotifyUrl === loadingUrl) return loadPromise;
    const requestGeneration = ++generation;
    loadingUrl = spotifyUrl;
    host.hidden = false;
    const provider = new URL(spotifyUrl).hostname === 'open.spotify.com' ? 'spotify' : 'youtube';
    if (provider !== 'spotify') {
      destroyController();
      fallbackEmbed(host, embedUrl, provider);
      currentUrl = spotifyUrl;
      loadingUrl = '';
      return true;
    }
    loadPromise = (async () => {
      const api = await loadSpotifyApi();
      if (disposed || requestGeneration !== generation || loadingUrl !== spotifyUrl) return false;
      destroyController();
      if (!api?.createController) {
        fallbackEmbed(host, embedUrl, provider);
        currentUrl = spotifyUrl;
        loadingUrl = '';
        return true;
      }
      const mount = document.createElement('div');
      mount.className = 'focus-spotify-controller';
      host.replaceChildren(mount);
      return new Promise((resolve) => {
        const controllerTimeout = window.setTimeout(() => {
          if (disposed || requestGeneration !== generation || loadingUrl !== spotifyUrl) {
            resolve(false);
            return;
          }
          fallbackEmbed(host, embedUrl, provider);
          currentUrl = spotifyUrl;
          loadingUrl = '';
          resolve(true);
        }, 5000);
        api.createController(mount, { url: spotifyUrl, width: '100%', height: 352 }, (nextController) => {
          window.clearTimeout(controllerTimeout);
          if (disposed || requestGeneration !== generation || loadingUrl !== spotifyUrl) {
            nextController.destroy?.();
            resolve(false);
            return;
          }
          controller = nextController;
          currentUrl = spotifyUrl;
          loadingUrl = '';
          normalizeEmbedFrame(host);
          if (resumeWhenReady) controller.resume?.();
          resolve(true);
        });
      });
    })();
    return loadPromise;
  }

  function clear() {
    generation += 1;
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
