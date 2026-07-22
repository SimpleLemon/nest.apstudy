const SDK_SRC = 'https://open.spotify.com/embed/iframe-api/v1';

let apiPromise = null;

function loadSpotifyApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (api) => {
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
  return apiPromise;
}

function fallbackEmbed(host, embedUrl) {
  if (host.querySelector('iframe')) return;
  const iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.title = 'Spotify playlist player';
  iframe.loading = 'lazy';
  iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  host.replaceChildren(iframe);
}

export function createSpotifyPlayer(host) {
  let controller = null;
  let currentUrl = '';
  let loadingUrl = '';
  let resumeWhenReady = false;

  async function load(spotifyUrl, embedUrl) {
    if (!host || !spotifyUrl || spotifyUrl === currentUrl || spotifyUrl === loadingUrl) return;
    loadingUrl = spotifyUrl;
    host.hidden = false;
    const api = await loadSpotifyApi();
    if (loadingUrl !== spotifyUrl) return;
    if (controller) {
      controller.loadEntity(spotifyUrl);
      currentUrl = spotifyUrl;
      loadingUrl = '';
      return;
    }
    if (!api?.createController) {
      fallbackEmbed(host, embedUrl);
      currentUrl = spotifyUrl;
      loadingUrl = '';
      return;
    }
    const mount = document.createElement('div');
    mount.className = 'focus-spotify-controller';
    host.replaceChildren(mount);
    api.createController(mount, { url: spotifyUrl, width: '100%', height: 352 }, (nextController) => {
      if (loadingUrl !== spotifyUrl) {
        nextController.destroy?.();
        return;
      }
      controller = nextController;
      currentUrl = spotifyUrl;
      loadingUrl = '';
      if (resumeWhenReady) controller.resume?.();
    });
  }

  function clear() {
    controller?.destroy?.();
    controller = null;
    currentUrl = '';
    loadingUrl = '';
    host?.replaceChildren();
    if (host) host.hidden = true;
  }

  function pause() {
    resumeWhenReady = false;
    controller?.pause?.();
  }

  function resume() {
    resumeWhenReady = true;
    controller?.resume?.();
  }

  return { clear, load, pause, resume, get currentUrl() { return currentUrl; } };
}
