(function registerSettingsDiscord(global) {
  const DISCORD_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" class="settings-discord-icon" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037 19.736 19.736 0 0 0-4.885 1.515.069.069 0 0 0-.032.027C.533 9.048-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.006 14.006 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.196.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" /></svg>';

  function createSettingsDiscord({ elements, state, endpoints, callbacks }) {
    const { escapeHtml, fetchJson, showToast } = callbacks;
  function renderDiscordButton() {
    const button = elements.discordButton;
    if (!button) {
      return;
    }
    const discord = state.discord || {};
    button.hidden = false;
    if (discord.linked) {
      button.classList.add('is-linked');
      button.innerHTML = `${DISCORD_ICON_SVG}<span>Linked</span>`;
      button.setAttribute('aria-label', 'Manage linked Discord account');
    } else {
      button.classList.remove('is-linked');
      button.innerHTML = `<span>Link</span>${DISCORD_ICON_SVG}<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>`;
      button.setAttribute('aria-label', 'Link your Discord account');
    }
  }
  
  function bindDiscordControls() {
    elements.discordButton?.addEventListener('click', () => {
      const discord = state.discord || {};
      if (discord.linked) {
        openDiscordModal();
        return;
      }
      const url = elements.discordButton.getAttribute('data-link-url');
      if (url) {
        window.location.href = url;
      }
    });
    elements.discordModalClosers.forEach((node) => {
      node.addEventListener('click', closeDiscordModal);
    });
    elements.discordUnlink?.addEventListener('click', () => void handleDiscordUnlink());
    elements.discordRelink?.addEventListener('click', () => void handleDiscordRelink());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && elements.discordModal && !elements.discordModal.hidden) {
        closeDiscordModal();
      }
    });
  }
  
  function openDiscordModal() {
    if (!elements.discordModal) {
      return;
    }
    const discord = state.discord || {};
    const username = discord.username || 'account';
    if (elements.discordUnlink) {
      elements.discordUnlink.textContent = `Unlink ${username}`;
    }
    elements.discordModal.hidden = false;
    elements.discordModal.classList.add('is-open');
    document.body.classList.add('settings-discord-modal-open');
  }
  
  function closeDiscordModal() {
    if (!elements.discordModal) {
      return;
    }
    elements.discordModal.hidden = true;
    elements.discordModal.classList.remove('is-open');
    document.body.classList.remove('settings-discord-modal-open');
  }
  
  async function handleDiscordUnlink() {
    try {
      await fetchJson(endpoints.discordUnlink, { method: 'POST' });
      state.discord = { linked: false, username: null };
      renderDiscordButton();
      closeDiscordModal();
      showToast('Discord account unlinked.', 'success');
    } catch (error) {
      showToast(error.message || 'Unable to unlink Discord account.', 'error');
    }
  }
  
  async function handleDiscordRelink() {
    // Unlinking before re-linking keeps a single Discord identity per account.
    try {
      await fetchJson(endpoints.discordUnlink, { method: 'POST' });
    } catch (error) {
      console.error(error);
    }
    const url = elements.discordButton?.getAttribute('data-link-url');
    if (url) {
      window.location.href = url;
    } else {
      closeDiscordModal();
    }
  }
  
  function notifyDiscordLinkResult() {
    let params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (error) {
      return;
    }
    if (params.get('discord') === 'error') {
      showToast('We could not link your Discord account. Please try again.', 'error');
      params.delete('discord');
      const query = params.toString();
      const newUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', newUrl);
    }
  }

  function renderConnectedServices() {
    if (!elements.connectedServices) {
      return;
    }
    if (!state.connectedServices.length) {
      elements.connectedServices.innerHTML = '<div class="settings-empty-state">No connected services.</div>';
      return;
    }
  
    elements.connectedServices.innerHTML = state.connectedServices.map((service) => {
      const label = escapeHtml(service.name || 'Connected service');
      const detail = escapeHtml(service.detail || service.description || 'Connected');
      return `<div class="settings-empty-state settings-connected-item"><strong>${label}</strong><p>${detail}</p></div>`;
    }).join('');
  }

    return {
      bindDiscordControls,
      renderConnectedServices,
      renderDiscordButton,
      notifyDiscordLinkResult,
    };
  }

  global.APStudySettingsDiscord = { createSettingsDiscord };
}(window));
