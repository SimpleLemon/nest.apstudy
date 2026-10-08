import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.TZ = 'America/New_York';

globalThis.window = {};
const source = await readFile(new URL('../../static/js/chat/presentation.js', import.meta.url), 'utf8');
const escapeBridge = `data:text/javascript,${encodeURIComponent('export const escapeHtml = (value) => String(value);')}`;
const presentation = await import(`data:text/javascript,${encodeURIComponent(source.replace('../core/ui-primitives-module.js', escapeBridge))}`);

test('chat presentation groups nearby messages by author and day', () => {
    const messages = [
        { id: '1', user_id: 'a', created_at: '2026-07-18T10:00:00Z' },
        { id: '2', user_id: 'a', created_at: '2026-07-18T10:05:00Z' },
        { id: '3', user_id: 'b', created_at: '2026-07-18T10:06:00Z' },
    ];
    assert.deepEqual(presentation.groupMessages(messages).map((group) => group.messages.length), [2, 1]);
});

test('chat timestamp formatting respects local calendar days', () => {
    const now = new Date(2026, 6, 18, 12, 0, 0);
    const yesterday = new Date(2026, 6, 17, 23, 30, 0);
    assert.match(presentation.formatMessageTimestamp(yesterday.toISOString(), now), /^Yesterday at /);
    assert.equal(presentation.plural(1, 'member', 'members'), '1 member');
    assert.equal(presentation.plural(2, 'member', 'members'), '2 members');
});

test('calendarDaysAgo names the signed local-day direction across DST boundaries', () => {
    for (const now of [new Date(2026, 6, 18, 12), new Date(2026, 2, 9, 0, 15), new Date(2026, 10, 2, 0, 15)]) {
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 30);
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        assert.equal(presentation.calendarDaysAgo(yesterday, now), 1);
        assert.equal(presentation.calendarDaysAgo(now, now), 0);
        assert.equal(presentation.calendarDaysAgo(tomorrow, now), -1);
        assert.match(presentation.formatMessageTimestamp(yesterday.toISOString(), now), /^Yesterday at /);
    }
});
