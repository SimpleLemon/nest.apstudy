import {
  state,
} from "./context.js";
import {
  hydrateFromPersistentCache,
} from "./cache.js";
import {
  renderMessageLoader,
  setStatus,
} from "./render-ui.js";
import {
  bootstrap,
} from "./load.js";
import {
  startPresenceRefreshTimer,
} from "./realtime.js";
import {
  bindEvents,
  setMembersCollapsed,
} from "./actions.js";

export async function startChat() {
  setMembersCollapsed(state.membersCollapsed);
  renderMessageLoader();
  const cachePromise = hydrateFromPersistentCache().catch((error) => {
    console.warn("Unable to hydrate chat cache", error);
    state.persistentCacheReady = true;
    return false;
  });
  const bootstrapPromise = bootstrap().catch((error) => {
    setStatus(error.message || "Unable to load chat.", "error");
    throw error;
  });
  await Promise.allSettled([cachePromise, bootstrapPromise]);
}

bindEvents();

startPresenceRefreshTimer();

void startChat();
