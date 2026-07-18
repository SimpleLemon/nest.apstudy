import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const brandDir = path.join(root, "static/images/brand");

async function pngDimensions(filename) {
    const buffer = await readFile(path.join(brandDir, filename));
    assert.equal(buffer.subarray(1, 4).toString(), "PNG");
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("local brand assets have purpose-sized PNG dimensions", async () => {
    for (const size of [16, 32, 64, 180, 192, 512]) {
        assert.deepEqual(await pngDimensions(`nest-logo-v1-${size}.png`), { width: size, height: size });
    }
    assert.ok((await stat(path.join(brandDir, "nest-logo-v1-32.png"))).size < 10_000);
    assert.ok((await stat(path.join(brandDir, "nest-logo-v1-64.png"))).size < 20_000);
});

test("core templates and runtimes no longer depend on the remote logo", async () => {
    const templateNames = (await readdir(path.join(root, "templates"))).filter((name) => name.endsWith(".html"));
    const sources = await Promise.all(templateNames.map((name) => readFile(path.join(root, "templates", name), "utf8")));
    const joined = sources.join("\n");
    assert.doesNotMatch(joined, /resources\.apstudy\.org\/images\/AP-Resources-Logo\.png/);
    assert.match(joined, /nest-logo-v1-32\.png/);
    assert.match(joined, /rel="manifest" href="\/manifest\.json"/);
    assert.match(await readFile(path.join(root, "static/js/core/navbar.js"), "utf8"), /nest-logo-v1-64\.png 2x/);
    assert.doesNotMatch(await readFile(path.join(root, "static/service-worker.js"), "utf8"), /resources\.apstudy\.org/);
});

test("application manifest uses correctly sized local icons and social previews remain intact", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "static/manifest.json"), "utf8"));
    assert.deepEqual(manifest.icons.map(({ src, sizes, type }) => ({ src, sizes, type })), [
        { src: "/static/images/brand/nest-logo-v1-192.png", sizes: "192x192", type: "image/png" },
        { src: "/static/images/brand/nest-logo-v1-512.png", sizes: "512x512", type: "image/png" },
    ]);
    const landing = await readFile(path.join(root, "templates/landing.html"), "utf8");
    assert.match(landing, /property="og:image" content="https:\/\/resources\.apstudy\.org\/images\/APResourcesBanner\.png"/);
    assert.match(landing, /name="twitter:image" content="https:\/\/resources\.apstudy\.org\/images\/APResourcesBanner\.png"/);
});
