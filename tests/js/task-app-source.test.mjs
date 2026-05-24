import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/tasks/task.js"), "utf8");

test("task app keeps list visibility mutations latest-write-wins", () => {
    assert.match(source, /const listsRef = React\.useRef\(lists\)/);
    assert.match(source, /const listMutationVersionsRef = React\.useRef\(new Map\(\)\)/);
    assert.match(source, /const version = \(versions\.get\(listId\) \|\| 0\) \+ 1/);
    assert.match(source, /if \(versions\.get\(listId\) !== version\) return/);
    assert.match(source, /const toggleListVisibility = React\.useCallback/);
    assert.match(source, /hidden: !currentList\.hidden/);
});
