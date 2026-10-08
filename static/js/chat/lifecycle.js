export function createChatLifecycle({ readState, state, audio, store, rooms, presence, realtime, view, bootstrap, media }) {
  let chatSoundCooldownTimer = null;
  let chatRuntimePaused = false;
  let chatRuntimeDisposed = false;
  let chatRequestController = new AbortController();
  let roomPrefetchIdleId = null;
  const transientChatTimers = new Set();
  const transientChatFrames = new Set();

  function scheduleTransientTimeout(callback, delay = 0) {
    const timer = window.setTimeout(() => {
      transientChatTimers.delete(timer);
      if (!chatRuntimePaused && !chatRuntimeDisposed) callback();
    }, delay);
    transientChatTimers.add(timer);
    return timer;
  }

  function scheduleTransientFrame(callback) {
    const frame = window.requestAnimationFrame(() => {
      transientChatFrames.delete(frame);
      if (!chatRuntimePaused && !chatRuntimeDisposed) callback();
    });
    transientChatFrames.add(frame);
    return frame;
  }

  function clearTransientWork() {
    transientChatTimers.forEach((timer) => window.clearTimeout(timer));
    transientChatTimers.clear();
    transientChatFrames.forEach((frame) => window.cancelAnimationFrame(frame));
    transientChatFrames.clear();
    if (roomPrefetchIdleId !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(roomPrefetchIdleId);
    }
    roomPrefetchIdleId = null;
  }

  async function fetchJson(url, options = {}) {
    const requestOptions = {
      ...options,
      jsonMode: "required",
      signal: options.signal || chatRequestController.signal,
    };
    return window.APStudyHttp.fetchJson(url, requestOptions);
  }

  function playChatSound(actorId) {
    if (!state.settings.chat_sound_enabled || !audio) return;
    if (actorId && state.user && String(actorId) === String(state.user.id)) return;
    if (chatSoundCooldownTimer) return;
    const handlePlaybackError = (error) => {
      // Autoplay denial and an interrupted optional sound do not affect chat.
      if (error?.name === "NotAllowedError" || error?.name === "AbortError") return;
      console.warn("Unable to play chat sound", error);
    };
    try {
      audio.currentTime = 0;
      void audio.play()?.catch(handlePlaybackError);
    } catch (error) {
      handlePlaybackError(error);
    }
    chatSoundCooldownTimer = window.setTimeout(() => {
      chatSoundCooldownTimer = null;
    }, 1500);
  }

  function stopChatRuntime({ dispose = false } = {}) {
    if (chatRuntimeDisposed || (chatRuntimePaused && !dispose)) return;
    chatRuntimePaused = true;
    if (dispose) chatRuntimeDisposed = true;
    if (dispose) media?.dispose(); else media?.pause();

    const activeCache = store.cacheFor(state.activeRoom);
    if (activeCache && view.messages) {
      store.saveRoomScroll(state.activeRoom, view.messages.scrollTop, { persist: false });
      void store.persistRoomCache(state.activeRoom);
    }

    presence.clearTypingPresence();
    rooms.cancelRoomSelection();
    realtime.resetRealtimeConnection();
    realtime.stopRealtimeFallback();
    presence.stopPresenceRefreshTimer();
    realtime.clearReconnectTimer();
    readState.cancelUnreadSummaryRefresh();
    window.clearTimeout(chatSoundCooldownTimer);
    chatSoundCooldownTimer = null;
    window.clearTimeout(state.searchTimer);
    state.searchTimer = null;
    window.clearTimeout(state.scrollSaveTimer);
    state.scrollSaveTimer = null;
    clearTransientWork();
    chatRequestController.abort();
    window.APStudyPresenceHeartbeat?.clearChatRoom?.();
    audio?.pause?.();
    rooms.closeRoomContextMenu();
    view.closeInlineProfilePopover();
  }

  function resumeChatRuntime() {
    if (chatRuntimeDisposed || !chatRuntimePaused) return;
    chatRuntimePaused = false;
    chatRequestController = new AbortController();
    media?.resume();
    presence.startPresenceRefreshTimer();
    if (state.serverBootstrapped) {
      void realtime.startRealtimeServices();
    } else {
      void bootstrap.startChat();
    }
    void readState.refreshChatSummary();
    presence.refreshViewingPresence();
  }

  const status = {
    get paused() { return chatRuntimePaused; },
    get disposed() { return chatRuntimeDisposed; },
  };

  function scheduleIdle(callback, options) {
    roomPrefetchIdleId = window.requestIdleCallback(() => {
      roomPrefetchIdleId = null;
      if (!chatRuntimePaused && !chatRuntimeDisposed) callback();
    }, options);
  }

  function register() {
    if (window.APStudyPageLifecycle?.register) {
      window.APStudyPageLifecycle.register({
        pause: () => stopChatRuntime(),
        resume: resumeChatRuntime,
        dispose: () => stopChatRuntime({ dispose: true }),
      });
    } else {
      window.addEventListener("pagehide", () => stopChatRuntime({ dispose: true }), { once: true });
    }
  }

  return { status, fetchJson, scheduleTransientTimeout, scheduleTransientFrame, scheduleIdle, playChatSound, register, stopChatRuntime, resumeChatRuntime };
}
