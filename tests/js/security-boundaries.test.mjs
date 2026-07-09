import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const globalSource = fs.readFileSync('static/js/core/global.js', 'utf8');

function csrfFetchWrapperSource() {
    const start = globalSource.indexOf('(() => {\n    if (window.__apstudyCsrfFetchInstalled');
    const end = globalSource.indexOf('\n})();', start);
    return globalSource.slice(start, end + '\n})();'.length);
}

function installCsrfFetchHarness(handler, initialCookie = 'csrf_token=stale') {
    let cookie = initialCookie;
    const calls = [];
    const document = {};
    Object.defineProperty(document, 'cookie', {
        get: () => cookie,
        set: (value) => { cookie = value; },
    });
    const nativeFetch = async (input, init) => {
        const request = input instanceof Request
            ? input
            : new Request(new URL(String(input), 'https://nest.apstudy.org'), init);
        calls.push({
            url: request.url,
            method: request.method,
            csrfToken: request.headers.get('X-CSRFToken'),
            body: await request.clone().text(),
        });
        return handler(request, { setCookie: (value) => { cookie = value; } });
    };
    const window = {
        fetch: nativeFetch,
        location: { href: 'https://nest.apstudy.org/notes/editor/note-1', origin: 'https://nest.apstudy.org' },
    };
    vm.runInNewContext(csrfFetchWrapperSource(), { window, document, Request, Headers, URL, Error });
    return { calls, fetch: window.fetch };
}

test('same-origin unsafe fetches receive the CSRF header', () => {
    assert.match(globalSource, /unsafeMethods = new Set\(\["POST", "PUT", "PATCH", "DELETE"\]\)/);
    assert.match(globalSource, /url\.origin !== window\.location\.origin/);
    assert.match(globalSource, /headers\.set\("X-CSRFToken", token\)/);
});

test('marked CSRF failures refresh once and retry the original mutation', async () => {
    let saveAttempts = 0;
    const harness = installCsrfFetchHarness((request, { setCookie }) => {
        if (request.url.endsWith('/auth/csrf')) {
            setCookie('csrf_token=fresh');
            return new Response(null, { status: 204 });
        }
        saveAttempts += 1;
        return saveAttempts === 1
            ? new Response('expired', { status: 400, headers: { 'X-APStudy-CSRF-Error': '1' } })
            : new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const response = await harness.fetch('https://nest.apstudy.org/api/notes/note-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{"content":"new text"}',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(harness.calls.map((call) => call.url), [
        'https://nest.apstudy.org/api/notes/note-1',
        'https://nest.apstudy.org/auth/csrf',
        'https://nest.apstudy.org/api/notes/note-1',
    ]);
    assert.equal(harness.calls[0].csrfToken, 'stale');
    assert.equal(harness.calls[2].csrfToken, 'fresh');
    assert.equal(harness.calls[2].body, '{"content":"new text"}');
});

test('ordinary 400 responses are never retried', async () => {
    const harness = installCsrfFetchHarness(() => new Response('invalid input', { status: 400 }));

    const response = await harness.fetch('https://nest.apstudy.org/api/notes/note-1', {
        method: 'PATCH',
        body: '{"content":"bad"}',
    });

    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 1);
});

test('concurrent CSRF failures share one token refresh', async () => {
    let refreshes = 0;
    let saveAttempts = 0;
    const harness = installCsrfFetchHarness(async (request, { setCookie }) => {
        if (request.url.endsWith('/auth/csrf')) {
            refreshes += 1;
            await Promise.resolve();
            setCookie('csrf_token=fresh');
            return new Response(null, { status: 204 });
        }
        saveAttempts += 1;
        return saveAttempts <= 2
            ? new Response('expired', { status: 400, headers: { 'X-APStudy-CSRF-Error': '1' } })
            : new Response(null, { status: 204 });
    });

    const responses = await Promise.all([
        harness.fetch('https://nest.apstudy.org/api/notes/note-1', { method: 'PATCH', body: 'one' }),
        harness.fetch('https://nest.apstudy.org/api/notes/note-1', { method: 'PATCH', body: 'two' }),
    ]);

    assert.deepEqual(responses.map((response) => response.status), [204, 204]);
    assert.equal(refreshes, 1);
});

test('logout uses a CSRF-protected POST instead of navigation GET', () => {
    assert.match(globalSource, /fetch\("\/logout", \{/);
    assert.match(globalSource, /method: "POST"/);
    assert.doesNotMatch(globalSource, /location\.assign\(`\$\{window\.location\.origin\}\/logout`\)/);
});
