import { escapeHtml } from "./presentation.js";

export function createChatComposer({ state, els, extensions, fetchJson, feedback, identity, loading, presence, rooms, scheduler, store, view }) {
  function roomIsWritable(room) {
    if (room?.type === "channel") {
      return rooms.channelIsWritable(state.channels.find((channel) => channel.id === room.id));
    }
    if (room?.type !== "thread") return false;
    const thread = state.threads.find((candidate) => candidate.id === room.id);
    return Boolean(thread && !thread.blocked);
  }

  function isActiveRoom(room) {
    return Boolean(
      room
      && state.activeRoom
      && identity.roomKey(state.activeRoom) === identity.roomKey(room)
    );
  }

  function updateComposerSubmitState() {
    if (!els.sendButton) return;
    const hasText = Boolean(els.input?.value.trim());
    const hasAttachment = Boolean(extensions.attachments?.readyIds?.().length);
    const hasGif = Boolean(extensions.mediaPicker?.hasSelection?.());
    const attachmentsBusy = Boolean(extensions.attachments?.isBusy?.());
    els.sendButton.disabled = !roomIsWritable(state.activeRoom)
      || (!hasText && !hasAttachment && !hasGif)
      || attachmentsBusy
      || state.messageSendInFlight;
  }

  function autosizeComposer() {
    if (!els.input) return;
    els.input.style.height = "auto";
    const nextHeight = Math.min(112, Math.max(24, els.input.scrollHeight));
    els.input.style.height = `${nextHeight}px`;
  }

  function setComposer(enabled, placeholder) {
    if (!els.composer || !els.input || !els.sendButton) return;
    els.composer.hidden = false;
    els.input.disabled = !enabled;
    els.input.placeholder = placeholder || "Message";
    autosizeComposer();
    updateComposerSubmitState();
  }

  async function sendActiveMessage(event) {
    event.preventDefault();
    const room = state.activeRoom;
    if (!room || !els.input) return;
    const content = els.input.value.trim();
    const attachmentIds = extensions.attachments?.readyIds?.() || [];
    const gifSelection = extensions.mediaPicker?.selection?.() || {};
    if (!content && !attachmentIds.length && !gifSelection.gif_id) return;
    if (extensions.attachments?.isBusy?.()) {
      feedback.setStatus("Wait for attachments to finish uploading before sending.", "error");
      return;
    }
    if (state.messageSendInFlight) return;
    if (!roomIsWritable(room)) return;

    state.messageSendInFlight = true;
    els.sendButton.disabled = true;
    presence.clearTypingPresence(room);
    const localId = `pending-${crypto.randomUUID()}`;
    const payloadBody = { content, attachment_ids: attachmentIds, ...gifSelection };
    try {
      const optimistic = {
        id: localId,
        user_id: state.user?.id,
        author_name: state.user?.name || state.user?.username || "You",
        author_username: state.user?.username || "",
        author_avatar_url: state.user?.picture_url || state.user?.picture || "",
        content: content || (gifSelection.gif_id ? "GIF" : "Attachment"),
        rendered_html: escapeHtml(content || ""),
        created_at: new Date().toISOString(),
        delivery_state: "sending",
        can_delete: false,
        attachments: [],
      };
      view.renderIncomingMessages(store.mergeRoomMessages(room, [optimistic]), { toBottom: true, markRead: false });
      const url = loading.currentRoomUrl(room);
      const payload = await fetchJson(url, {
        method: "POST",
        body: JSON.stringify(payloadBody),
      });
      store.removeMessageFromCaches(localId);
      view.renderRemovedMessage(localId);
      if (isActiveRoom(room)) {
        els.input.value = "";
        autosizeComposer();
        extensions.attachments?.clear?.();
        extensions.mediaPicker?.clear?.(true);
      }
      const cache = store.cacheFor(room);
      if (cache && payload.message) {
        view.renderIncomingMessages(store.mergeRoomMessages(room, [payload.message]), { toBottom: true });
      }
      if (isActiveRoom(room)) presence.refreshViewingPresence();
      scheduler.schedulePersistentBootstrapSave();
    } catch (error) {
      const failed = store.updateMessageDelivery(room, localId, "failed")?.messages.find((message) => message.id === localId);
      if (failed) {
        state.failedMessages.set(localId, { room, payload: payloadBody });
        if (isActiveRoom(room)) view.patchMessageInDom(failed);
      }
      feedback.setStatus(error.message || "Unable to send message.", "error");
    } finally {
      state.messageSendInFlight = false;
      updateComposerSubmitState();
    }
  }

  async function retryMessage(messageId) {
    const failed = state.failedMessages.get(messageId);
    if (!failed || state.messageSendInFlight) return;
    if (!roomIsWritable(failed.room)) {
      feedback.setStatus("You can’t send messages to this conversation right now.", "error");
      return;
    }
    const message = store.updateMessageDelivery(failed.room, messageId, "sending")?.messages.find((row) => row.id === messageId);
    if (message) {
      view.patchMessageInDom(message);
    }
    state.messageSendInFlight = true;
    els.sendButton.disabled = true;
    try {
      const response = await fetchJson(loading.currentRoomUrl(failed.room), {
        method: "POST",
        body: JSON.stringify(failed.payload),
      });
      state.failedMessages.delete(messageId);
      store.removeMessageFromCaches(messageId);
      view.renderRemovedMessage(messageId);
      if (response.message) {
        view.renderIncomingMessages(store.mergeRoomMessages(failed.room, [response.message]), { toBottom: true });
      }
      if (isActiveRoom(failed.room)) {
        extensions.attachments?.clear?.();
        extensions.mediaPicker?.clear?.(true);
      }
    } catch (error) {
      if (message) {
        const restored = store.updateMessageDelivery(failed.room, messageId, "failed")?.messages.find((row) => row.id === messageId);
        if (restored && isActiveRoom(failed.room)) view.patchMessageInDom(restored);
      }
      feedback.setStatus(error.message || "Unable to send message.", "error");
    } finally {
      state.messageSendInFlight = false;
      updateComposerSubmitState();
    }
  }

  function handleComposerKeydown(event) {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.shiftKey) {
      scheduler.scheduleTransientTimeout(() => {
        autosizeComposer();
        presence.scheduleTypingPresence();
      }, 0);
      return;
    }
    event.preventDefault();
    if (state.messageSendInFlight) return;
    if (els.composer?.requestSubmit) {
      els.composer.requestSubmit();
    } else {
      void sendActiveMessage(event);
    }
  }

  function bindEvents() {
    els.composer?.addEventListener("submit", sendActiveMessage);
    els.input?.addEventListener("keydown", handleComposerKeydown);
    els.input?.addEventListener("input", () => {
      autosizeComposer();
      presence.scheduleTypingPresence();
      updateComposerSubmitState();
    });
  }

  return {
    autosizeComposer,
    bindEvents,
    retryMessage,
    sendActiveMessage,
    setComposer,
    updateComposerSubmitState,
  };
}
