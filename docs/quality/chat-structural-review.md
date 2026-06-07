# Chat Structural Review

`static/js/chat.js` remains intentionally consolidated after the June 2026
quality pass. It mixes several high-coupling responsibilities:

- room cache hydration and IndexedDB persistence
- realtime room/message subscriptions
- Appwrite presence and typing presence
- message rendering and grouping
- mobile drawer/member/profile panel state

The safest future split is not a line-count-only extraction. Recommended
boundaries:

1. `static/js/chat/cache.js` for `openChatCacheDb`, persistent room/bootstrap
   cache reads and writes, cache cursor normalization, and scroll persistence.
2. `static/js/chat/presence.js` for presence scope keys, Appwrite presence
   upsert/delete/list calls, typing TTL timers, and presence refresh timers.
3. `static/js/chat/rendering.js` for message grouping, timestamp formatting,
   attachment/emoji HTML, room list HTML, and profile panel HTML.
4. `static/js/chat/realtime.js` for Appwrite channel subscription setup,
   reconnect guards, and realtime event fan-out into the cache/render layer.

Those modules should be introduced behind factories that receive `state`,
`els`, and a small callback surface. This preserves the existing browser-global
script loading model while allowing `tests/js/chat-ui-realtime.test.mjs` to
combine sources the same way the calendar, files, settings, and notes splits do.

This review supersedes the stale structural wontfix marker by documenting the
current coupling and the concrete split plan. A direct split should be handled
as its own focused chat refactor because the realtime/presence/cache behavior is
user-visible and heavily stateful.
