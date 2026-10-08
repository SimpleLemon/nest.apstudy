import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { parse } from "acorn";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function runAdminRuntime(relativePath, extra = {}) {
  const sandbox = {
    URL, Intl, Date, Number, Math, String, Array, Set,
    window: {
      APStudyUIPrimitives: { escapeHtml: String },
      location: { origin: "https://example.test" },
      ...extra.window,
    },
    document: {
      readyState: "complete",
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      ...extra.document,
    },
    ...extra.globals,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.window.fetch = sandbox.fetch;
  const transport = await readFile(path.join(repoRoot, "static/js/core/http.js"), "utf8");
  vm.runInNewContext(transport, sandbox);
  sandbox.window.APStudyHttp = sandbox.window.APStudyCoreServices.http.createHttpService({ window: sandbox.window });
  const context = vm.createContext(sandbox);
  const modules = new Map();

  // Evaluate each actual static import in its own scope. The shared primitive
  // bridge uses the fixture's HTML encoder, so these tests need no DOM package.
  async function load(filename) {
    if (filename.endsWith("/core/ui-primitives-module.js")) return sandbox.window.APStudyUIPrimitives;
    if (modules.has(filename)) return modules.get(filename);
    const source = await readFile(path.join(repoRoot, filename), "utf8");
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const imports = {};
    const edits = [];
    const exports = [];
    for (const statement of ast.body) {
      if (statement.type === "ImportDeclaration") {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), statement.source.value));
        const values = await load(dependency);
        for (const specifier of statement.specifiers) {
          assertNamedImport(specifier);
          imports[specifier.local.name] = values[specifier.imported.name];
        }
        edits.push({ start: statement.start, end: statement.end, text: "" });
      } else if (statement.type === "ExportNamedDeclaration") {
        if (statement.declaration) throw new Error(`Unsupported declaration export in ${filename}`);
        exports.push(...statement.specifiers.map((specifier) => `${specifier.exported.name}: ${specifier.local.name}`));
        edits.push({ start: statement.start, end: statement.end, text: "" });
      }
    }
    let body = source;
    for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
    const evaluate = vm.runInContext(`(imports) => { const { ${Object.keys(imports).join(", ")} } = imports;\n${body}\nreturn { ${exports.join(", ")} }; }`, context, { filename });
    const result = evaluate(imports);
    modules.set(filename, result);
    return result;
  }
  const exports = await load(relativePath);
  return { window: sandbox.window, exports };
}

function assertNamedImport(specifier) {
  if (specifier.type !== "ImportSpecifier") throw new Error(`Unsupported ${specifier.type} in admin fixture`);
}

export async function runAdminBrowserScript(relativePath, extra = {}) {
  return (await runAdminRuntime(relativePath, extra)).window;
}

export async function runAdminBrowserModule(relativePath, extra = {}) {
  return (await runAdminRuntime(relativePath, extra)).exports;
}
