import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asset = (name) => path.join(root, "static/images/landing", name);

test("landing hero provides responsive WebP and PNG candidates with stable intrinsic dimensions", async () => {
    const template = await readFile(path.join(root, "templates/landing.html"), "utf8");
    assert.match(template, /<picture>/);
    assert.match(template, /type="image\/webp"/);
    for (const width of [640, 960, 1400, 1800]) assert.match(template, new RegExp(`nest-interface-hero-${width}\\.webp`));
    for (const width of [640, 960, 1400]) assert.match(template, new RegExp(`nest-interface-hero-${width}\\.png`));
    assert.match(template, /sizes="100vw"/);
    assert.match(template, /width="1800"\s+height="1013"/);
    assert.match(template, /fetchpriority="high"/);
    assert.doesNotMatch(template, /landing-hero-image[^>]*loading="lazy"/);
});

test("responsive hero candidates materially reduce transferred bytes", async () => {
    const originalBytes = (await stat(asset("nest-interface-hero.png"))).size;
    const mobileBytes = (await stat(asset("nest-interface-hero-640.webp"))).size;
    const desktopBytes = (await stat(asset("nest-interface-hero-1400.webp"))).size;
    assert.ok(mobileBytes < originalBytes * 0.03, `${mobileBytes} vs ${originalBytes}`);
    assert.ok(desktopBytes < originalBytes * 0.08, `${desktopBytes} vs ${originalBytes}`);
    assert.ok(mobileBytes < desktopBytes);
});
