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

  global.AdminSystem = Object.freeze({ waitForRestart });
})(window);
