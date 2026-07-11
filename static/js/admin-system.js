(function initAdminSystem(global) {
  "use strict";

  const delay = (milliseconds) => new Promise((resolve) => global.setTimeout(resolve, milliseconds));

  async function waitForRestart({
    endpoint,
    restartDelaySeconds,
    timeoutMs = 60000,
    pollIntervalMs = 1000,
    fetchImpl = global.fetch.bind(global),
    delayImpl = delay,
    nowImpl = Date.now,
  }) {
    const restartDelayMs = Math.max(0, Number(restartDelaySeconds) || 0) * 1000;
    await delayImpl(restartDelayMs);

    const deadline = nowImpl() + timeoutMs;
    while (nowImpl() < deadline) {
      try {
        const response = await fetchImpl(endpoint, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.ok) return;
      } catch (_error) {
        // A connection failure is expected while the service is restarting.
      }

      const remainingMs = deadline - nowImpl();
      if (remainingMs <= 0) break;
      await delayImpl(Math.min(pollIntervalMs, remainingMs));
    }

    throw new Error("Nest did not become available in time. Refresh this page manually.");
  }

  function startVisiblePolling({
    onTick,
    intervalMs = 1000,
    documentImpl = global.document,
    setIntervalImpl = global.setInterval.bind(global),
    clearIntervalImpl = global.clearInterval.bind(global),
  }) {
    let intervalId = null;
    const isVisible = () => documentImpl.visibilityState === "visible";
    const stop = () => {
      if (intervalId === null) return;
      clearIntervalImpl(intervalId);
      intervalId = null;
    };
    const start = () => {
      if (intervalId !== null || !isVisible()) return;
      intervalId = setIntervalImpl(onTick, intervalMs);
    };
    const handleVisibilityChange = () => {
      if (!isVisible()) {
        stop();
        return;
      }
      onTick();
      start();
    };

    documentImpl.addEventListener("visibilitychange", handleVisibilityChange);
    start();

    return () => {
      stop();
      documentImpl.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }

  global.AdminSystem = Object.freeze({ waitForRestart, startVisiblePolling });
})(window);
