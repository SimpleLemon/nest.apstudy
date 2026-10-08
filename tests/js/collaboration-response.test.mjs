import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import test from 'node:test';

// Execute the source-owned response boundary without starting the sidecar.
const source = readFileSync(new URL('../../collaboration/server.mjs', import.meta.url), 'utf8');
const declaration = parse(source, { sourceType: 'module', ecmaVersion: 'latest' }).body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'parseJsonResponse');
const parseJsonResponse = vm.runInNewContext(`${source.slice(declaration.start, declaration.end)}; parseJsonResponse`, { Error });

test('sidecar response decoding keeps malformed successful JSON distinct from access validation', async () => {
    const response = new Response('{broken', { status: 200 });
    await assert.rejects(parseJsonResponse(response), error => {
        assert.equal(error.message, 'Invalid JSON response from Flask collaboration API.');
        assert.equal(error.status, 200);
        assert.equal(error.response, response);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
    });
});

test('sidecar HTTP failure retains server message, response, status and parsing cause', async () => {
    for (const [body, message, malformed] of [
        ['{"error":"Access denied."}', 'Access denied.', false],
        ['{broken', 'Flask request failed with 403', true],
        ['null', 'Flask request failed with 403', false],
    ]) {
        const response = new Response(body, { status: 403 });
        await assert.rejects(parseJsonResponse(response), error => {
            assert.equal(error.message, message);
            assert.equal(error.status, 403);
            assert.equal(error.response, response);
            assert.equal(error.cause instanceof SyntaxError, malformed);
            return true;
        });
    }
    const payload = { durable_revision: 3, document_generation: 'initial' };
    assert.deepEqual(await parseJsonResponse(new Response(JSON.stringify(payload))), payload);
});
