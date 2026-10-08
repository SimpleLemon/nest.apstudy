import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

const chatRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../static/js/chat");
const parse = (source) => acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}
const propertyName = (property) => property.key?.name || property.key?.value;

test("chat composition supplies exactly the declared per-domain operations", async () => {
  const sources = new Map(await Promise.all((await readdir(chatRoot))
    .filter((name) => name.endsWith(".js"))
    .map(async (name) => [name, parse(await readFile(path.join(chatRoot, name), "utf8"))])));
  const factories = new Map();
  for (const [name, ast] of sources) {
    walk(ast, (node) => {
      if (node.type !== "FunctionDeclaration" || !/^createChat/.test(node.id.name)) return;
      if (node.params[0]?.type !== "ObjectPattern") return;
      const parameters = new Set(node.params[0].properties.map(propertyName));
      const members = new Map();
      walk(node.body, (child) => {
        if (child.type !== "MemberExpression" || child.computed || !parameters.has(child.object?.name)) return;
        const domain = child.object.name;
        if (["root", "state", "audio", "extensions", "persistentCache", "lifecycle"].includes(domain)) return;
        const consumed = members.get(domain) || new Set();
        consumed.add(child.property.name);
        members.set(domain, consumed);
      });
      factories.set(node.id.name, { name, parameters, members });
    });
  }
  let checked = 0;
  walk(sources.get("runtime.js"), (node) => {
    if (node.type !== "CallExpression" || !factories.has(node.callee?.name)) return;
    const contract = factories.get(node.callee.name);
    assert.equal(node.arguments[0]?.type, "ObjectExpression", `${node.callee.name} needs an explicit dependency contract`);
    const supplied = new Map(node.arguments[0].properties.map((property) => [propertyName(property), property.value]));
    assert.deepEqual([...supplied.keys()].sort(), [...contract.parameters].sort(), `${contract.name} parameter contract`);
    for (const [domain, consumed] of contract.members) {
      assert.equal(supplied.get(domain)?.type, "ObjectExpression", `${contract.name}: ${domain} cannot receive a whole application domain`);
      const provided = supplied.get(domain).properties.map(propertyName);
      assert.deepEqual(provided.sort(), [...consumed].sort(), `${contract.name}: ${domain} must provide each consumed operation, and no unrelated ones`);
    }
    checked += 1;
  });
  assert.equal(checked, 11, "All eleven chat domain factories must be verified");
});
