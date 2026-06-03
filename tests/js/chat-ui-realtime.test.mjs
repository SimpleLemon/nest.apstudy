import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFor(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[0];
}

test("chat uses realtime event signals instead of message polling", async () => {
  const source = await sourceFor("static/js/chat.js");

  assert.doesNotMatch(source, /pollTimer/);
  assert.doesNotMatch(source, /setInterval\([^)]*loadMessages/s);
  assert.match(source, /Channel\?\.tablesdb/);
  assert.match(source, /\.table\(tableId\)\.row\(\)/);
  assert.match(source, /client\.subscribe/);
  assert.match(source, /handleRealtimePayload/);
  assert.match(source, /message_updated/);
});

test("chat uses Appwrite Presences for online and typing state", async () => {
  const script = await sourceFor("static/js/chat.js");
  const appwrite = await sourceFor("static/js/appwrite.js");
  const template = await sourceFor("templates/chat.html");

  assert.match(template, /appwrite@25\.0\.0/);
  assert.match(appwrite, /new Appwrite\.Presences\(client\)/);
  assert.match(appwrite, /new Appwrite\.Realtime\(client\)/);
  assert.match(appwrite, /window\.Permission = Appwrite\.Permission/);
  assert.match(appwrite, /window\.Role = Appwrite\.Role/);
  assert.match(appwrite, /window\.Query = Appwrite\.Query/);
  assert.match(appwrite, /window\.Channel = Appwrite\.Channel/);
  assert.doesNotMatch(script, /fetchJson\("\/api\/chat\/presence"/);
  assert.match(script, /presences\.list/);
  assert.match(script, /realtime\.upsertPresence/);
  assert.match(script, /Channel\?\.presences/);
  assert.match(script, /const VIEWING_PRESENCE_TTL_MS = 90000/);
  assert.match(script, /const TYPING_PRESENCE_TTL_MS = 8000/);
  assert.match(script, /compactHash/);
  assert.match(script, /tabId: currentTabId\(\)/);
  assert.doesNotMatch(script, /metadata:\s*\{[^}]*content/s);
  assert.match(script, /function renderTypingIndicator/);
  assert.match(script, /Several people are typing\.\.\./);
  assert.match(script, /applyPresenceRecord\(\{\s*\.\.\.\(presence \|\| \{\}\)/);
  assert.match(script, /renderPresenceDrivenUi\(\)/);
});

test("chat keeps a page lifetime room cache with delta loading", async () => {
  const source = await sourceFor("static/js/chat.js");

  assert.match(source, /roomCache: new Map\(\)/);
  assert.match(source, /function cacheFor\(room\)/);
  assert.match(source, /latestCursor/);
  assert.match(source, /after: cache\.latestCursor/);
  assert.match(source, /removeMessageFromCaches/);
});

test("chat persists user-scoped IndexedDB cache until logout", async () => {
  const script = await sourceFor("static/js/chat.js");
  const template = await sourceFor("templates/chat.html");
  const globalScript = await sourceFor("static/js/global.js");

  assert.match(template, /data-current-user-id="\{\{ user\.id or '' \}\}"/);
  assert.match(script, /const CHAT_CACHE_DB_NAME = "apstudy-chat-cache"/);
  assert.match(script, /const CHAT_CACHE_SCHEMA = "v1"/);
  assert.match(script, /function persistentCacheKey\(suffix\)/);
  assert.match(script, /\$\{CHAT_CACHE_SCHEMA\}:user:\$\{userId\}:\$\{suffix\}/);
  assert.match(script, /window\.indexedDB\.open\(CHAT_CACHE_DB_NAME, CHAT_CACHE_DB_VERSION\)/);
  assert.match(globalScript, /indexedDB\.deleteDatabase\("apstudy-chat-cache"\)/);
});

test("chat hydrates cached rooms before silent refresh and limits persisted messages", async () => {
  const script = await sourceFor("static/js/chat.js");

  assert.match(script, /const CHAT_CACHE_MESSAGE_LIMIT = 50/);
  assert.match(script, /\.slice\(-CHAT_CACHE_MESSAGE_LIMIT\)/);
  assert.match(script, /function normalizeCachedMessage\(message\)/);
  assert.match(script, /normalized\.can_delete = false/);
  assert.match(script, /function hydrateFromPersistentCache\(\)/);
  assert.match(script, /await hydrateRoomFromPersistentCache\(room\)/);
  assert.match(script, /await selectRoom\(room, \{ fromCacheHydration: true, quiet: true \}\)/);
  assert.match(script, /if \(renderCachedRoom\(room\)\)/);
  assert.match(script, /await loadMessages\(\{ after: cache\.latestCursor, quiet: true \}\)/);
  assert.match(script, /scheduleRoomPrefetches/);
  assert.match(script, /requestIdleCallback/);
});

test("chat uses message-pane loader and profile toggle tooltip polish", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");
  const template = await sourceFor("templates/chat.html");

  assert.match(script, /function renderMessageLoader/);
  assert.match(script, /APStudyLoader\.html\(label, \{ sizePx: 46, textToneClass: "text-on-surface" \}\)/);
  assert.match(styles, /\.chat-message-loader/);
  assert.match(template, /title="Show user profile"/);
  assert.match(script, /const label = state\.membersCollapsed \? "Show user profile" : "Hide user profile"/);
  assert.match(script, /setAttribute\("title", label\)/);
  assert.match(styles, /#chat-room-symbol\.is-avatar\s*\{[\s\S]*border-radius: 50%/);
  assert.match(styles, /#chat-room-symbol img\s*\{[\s\S]*object-fit: cover/);
});

test("chat renders university pending state in the main panel only", async () => {
  const script = await sourceFor("static/js/chat.js");
  const template = await sourceFor("templates/chat.html");

  assert.match(script, /function renderApprovalNotice/);
  assert.match(script, /Waiting Admin Approval\./);
  assert.doesNotMatch(template, /chat-university-pending/);
  assert.doesNotMatch(template, /chat-pending-card/);
});

test("chat direct messages render presence dots and profile-only side pane", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");

  assert.match(script, /dmPresenceMarkup/);
  assert.match(script, /chat-presence-dot/);
  assert.doesNotMatch(script, /function dmPresenceMarkup\(status\)[\s\S]*chat-presence-dot[\s\S]*function renderThreads/);
  assert.doesNotMatch(script, /Direct message/);
  assert.match(styles, /chat-presence-dot\.is-online/);
  assert.match(styles, /chat-presence-dot\.is-offline/);
  assert.match(script, /is-dm-profile/);
});

test("chat groups close same-author messages and formats timestamps compactly", async () => {
  const source = await sourceFor("static/js/chat.js");

  assert.match(source, /const MESSAGE_GROUP_WINDOW_MS = 7 \* 60 \* 1000/);
  assert.match(source, /function groupMessages\(messages\)/);
  assert.match(source, /function shouldGroupMessage\(previous, next\)/);
  assert.match(source, /localDateKey\(previousDate\) !== localDateKey\(nextDate\)/);
  assert.match(source, /Yesterday at \$\{time\}/);
  assert.match(source, /chat-message-continuation-time/);
});

test("chat keeps the composer compact and message stack bottom aligned", async () => {
  const styles = await sourceFor("static/css/chat.css");
  const composer = cssBlock(styles, ".chat-composer");

  assert.match(styles, /\.chat-main-panel\s*\{[\s\S]*display: flex[\s\S]*flex-direction: column/);
  assert.match(styles, /\.chat-messages\s*\{[\s\S]*flex: 1 1 auto[\s\S]*min-height: 0[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.chat-message-stack\s*\{[^}]*margin-top: auto/s);
  assert.match(composer, /flex: 0 0 auto/);
  assert.match(composer, /align-self: stretch/);
  assert.doesNotMatch(composer, /align-self: end/);
  assert.doesNotMatch(composer, /position: sticky/);
  assert.doesNotMatch(composer, /position: absolute/);
  assert.match(styles, /\.chat-typing-indicator/);
});

test("chat renders discord image attachments as plain lazy images", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");

  assert.match(script, /function renderImages\(images\)/);
  assert.match(script, /renderImages\(message\.images \|\| \[\]\)/);
  assert.match(script, /class="chat-message-image"/);
  assert.match(script, /loading="lazy"/);
  assert.match(styles, /\.chat-message-images/);
  assert.match(styles, /\.chat-message-image/);
});

test("chat styles discord custom emojis as inline lazy images", async () => {
  const styles = await sourceFor("static/css/chat.css");

  assert.match(styles, /\.chat-custom-emoji\s*\{/);
  assert.match(styles, /width: 1\.375em/);
  assert.match(styles, /height: 1\.375em/);
  assert.match(styles, /object-fit: contain/);
  assert.match(styles, /vertical-align: -0\.32em/);
});

test("scheduler uses discord gateway with slow reconciliation", async () => {
  const scheduler = await sourceFor("services/scheduler.py");
  const api = await sourceFor("blueprints/chat_api.py");
  const gateway = await sourceFor("services/discord_gateway.py");

  assert.match(scheduler, /def _reconcile_discord_chat\(app\):/);
  assert.match(scheduler, /sync_discord_channels\(emit_events=True\)/);
  assert.match(scheduler, /DISCORD_CHAT_RECONCILE_SECONDS/);
  assert.match(scheduler, /id="reconcile_discord_chat"/);
  assert.match(scheduler, /start_discord_gateway\(app\)/);
  assert.match(gateway, /discord\.Client\(intents=intents\)/);
  assert.match(gateway, /on_message/);
  assert.match(gateway, /on_raw_message_edit/);
  assert.match(gateway, /on_raw_message_delete/);
  assert.match(api, /def sync_discord_channels\(emit_events=True\):/);
  assert.match(api, /_sync_discord_channel\(channel, emit_events=emit_events\)/);
  assert.match(api, /_upsert_discord_message\(channel, message, emit_event=emit_events\)/);
  assert.match(api, /emit_chat_event\(\s*"channel",\s*channel_id,\s*"message_created"/);
  assert.match(api, /"message_updated"/);
  assert.match(api, /@chat_api_bp\.route\("\/api\/chat\/discord\/messages", methods=\["POST"\]\)/);
  assert.match(api, /def discord_message_ingest\(\):/);
  assert.match(api, /_valid_discord_ingest_request\(\)/);
});

test("global sidebar chat badge uses slow summary polling only", async () => {
  const sidebar = await sourceFor("static/js/sidebar.js");

  assert.match(sidebar, /data-chat-unread-badge/);
  assert.match(sidebar, /\/api\/chat\/summary/);
  assert.match(sidebar, /const pollMs = 120000/);
  assert.match(sidebar, /document\.visibilityState === 'hidden'/);
  assert.doesNotMatch(sidebar, /client\.subscribe/);
  assert.doesNotMatch(sidebar, /\/api\/chat\/channels\/.*messages/);
});

test("chat textarea enter sends and shift enter keeps multiline input", async () => {
  const script = await sourceFor("static/js/chat.js");

  assert.match(script, /function handleComposerKeydown\(event\)/);
  assert.match(script, /event\.key !== "Enter"/);
  assert.match(script, /event\.shiftKey/);
  assert.match(script, /event\.preventDefault\(\)/);
  assert.match(script, /els\.composer\.requestSubmit\(\)/);
  assert.match(script, /addEventListener\("keydown", handleComposerKeydown\)/);
});

test("chat renders discord mention pills and scalable message avatars", async () => {
  const styles = await sourceFor("static/css/chat.css");

  assert.match(styles, /--chat-message-avatar-size: 42px/);
  assert.match(styles, /grid-template-columns: var\(--chat-message-avatar-size\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.chat-message-avatar\s*\{[\s\S]*width: 100%[\s\S]*aspect-ratio: 1/);
  assert.match(styles, /--chat-message-avatar-size: 34px/);
  assert.match(styles, /\.chat-mention\s*\{/);
  assert.match(styles, /\.chat-mention-role\s*\{/);
  assert.match(styles, /font-weight: 650/);
});

test("chat history banner is closeable per session and only for discord history rooms", async () => {
  const script = await sourceFor("static/js/chat.js");
  const template = await sourceFor("templates/chat.html");
  const styles = await sourceFor("static/css/chat.css");

  assert.match(script, /closedHistoryBanners: new Set\(\)/);
  assert.match(script, /DISCORD_HISTORY_CHANNEL_IDS = new Set\(\["nest_announcements", "nest_chat"\]\)/);
  assert.match(script, /channel\.kind === "discord"/);
  assert.match(script, /channel\.history_limited === true/);
  assert.match(script, /state\.closedHistoryBanners\.add\(channelId\)/);
  assert.doesNotMatch(script, /localStorage\.setItem\([^)]*history/i);
  assert.match(template, /id="chat-history-close"/);
  assert.match(styles, /chat-history-close/);
  assert.match(styles, /\.chat-history-limited\[hidden\]/);
});

test("chat DM pane uses compact public profile card fields", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");

  for (const marker of ["profile-tile", "profile-tile-banner", "profile-tile-details", "Member Since"]) {
    assert.match(script, new RegExp(marker));
  }
  assert.match(script, /profileDetail\("Education"/);
  assert.match(script, /profile-tile-detail-emory/);
  assert.match(script, /profile-tile-detail-early-member/);
  assert.match(styles, /\.chat-profile-card \.profile-tile/);
  assert.match(styles, /background: #012169/);
  assert.match(styles, /linear-gradient\(135deg, rgba\(255, 255, 255, 0\.12\), #ffdf6b 18%, #b88724 48%/);
  assert.match(styles, /\.chat-profile-card \.profile-tile-detail-early-member::after/);
});

test("chat active users pane has desktop collapse controls", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");
  const template = await sourceFor("templates/chat.html");

  assert.match(template, /data-toggle-members/);
  assert.match(template, /chat-profile-toggle/);
  assert.doesNotMatch(template, /data-collapse-members/);
  assert.match(script, /profileToggle/);
  assert.match(template, /data-restore-members/);
  assert.match(script, /setMembersCollapsed/);
  assert.match(styles, /members-collapsed/);
});

test("chat DM header uses avatar status dot without online text and focuses composer", async () => {
  const script = await sourceFor("static/js/chat.js");
  const styles = await sourceFor("static/css/chat.css");

  assert.match(script, /chat-room-avatar-wrap/);
  assert.match(script, /els\.roomMeta\.textContent = ""/);
  assert.match(script, /els\.input\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /\.chat-topbar\s*\{[\s\S]*height: 64px/);
  assert.match(styles, /#chat-room-symbol\.is-avatar\s*\{[\s\S]*overflow: visible/);
});
