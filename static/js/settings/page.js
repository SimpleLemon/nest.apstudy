import { createSettingsAccount } from './account.js';
import { createSettingsCalendar } from './calendar.js';
import { createSettingsDiscord } from './discord.js';
import { createSettingsInvites } from './invites.js';
import { createSettingsNavigation } from './navigation.js';
import { createSettingsPreferences } from './preferences.js';
import { createSettingsProfile } from './profile.js';
import { createSettingsSummary } from './summary.js';
import { bindSettingsCopyButtons } from './copy-controls.js';
import { initializeExtensionSettings } from './extension.js';
import { initializeNotificationSettings } from './notifications.js';
import { fetchJson, showToast } from './utils.js';

export function initializeSettingsPage() {
  const profileState = { account: null, profile: null, profileBaseline: null, profileDirty: false, profileSaving: false };
  const preferenceState = { settings: null, pendingTheme: '' };
  const calendarState = { otherCalendarUrls: [] };
  const discordState = { discord: { linked: false, username: null } };
  const summaryState = { entitlements: null, storageUsageBytes: 0, notesCount: 0, filesCount: 0, connectedServices: [] };
  const profile = createSettingsProfile(profileState, () => profile.hydrate());
  const preferences = createSettingsPreferences(preferenceState);
  const calendar = createSettingsCalendar(calendarState, preferenceState);
  const discord = createSettingsDiscord(discordState);
  const summary = createSettingsSummary(summaryState);
  const invites = createSettingsInvites();
  const navigation = createSettingsNavigation(invites.activateInvites);

  function populateFields() {
    profile.hydrate();
    preferences.hydrate();
    calendar.hydrate();
    summary.renderStorageUsage();
    discord.renderDiscordButton();
  }

  summary.renderSettingsSkeleton();
  navigation.bindNavigation();
  bindSettingsCopyButtons();
  profile.mount();
  preferences.mount();
  calendar.mount();
  discord.bindDiscordControls();
  createSettingsAccount(() => profileState.profile?.email || profileState.account?.email || '').mount();
  invites.bindInviteControls();
  initializeExtensionSettings();
  initializeNotificationSettings();

  return bootstrap();

  async function bootstrap() {
    try {
      const data = await fetchJson('/settings/api/bootstrap');
      profileState.account = data.account || data.profile || null;
      profileState.profile = data.profile || null;
      preferenceState.settings = data.settings || null;
      calendarState.otherCalendarUrls = Array.isArray(data.other_calendar_urls) ? data.other_calendar_urls : [];
      discordState.discord = data.discord && typeof data.discord === 'object' ? data.discord : { linked: false, username: null };
      summaryState.entitlements = data.entitlements || null;
      summaryState.storageUsageBytes = Number(data.storage_usage_bytes || 0);
      summaryState.notesCount = Number(data.notes_count || 0);
      summaryState.filesCount = Number(data.files_count || 0);
      summaryState.connectedServices = Array.isArray(data.connected_services) ? data.connected_services : [];
      populateFields();
      summary.renderEntitlements();
      discord.notifyDiscordLinkResult();
      summary.renderConnectedServices();
      preferences.syncSavedPreferences();
      navigation.syncHashOnLoad();
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Refresh the page and try again.', 'error', { title: 'Couldn’t load settings' });
      navigation.syncHashOnLoad();
    } finally {
      summary.clearSettingsSkeleton();
    }
  }
}
