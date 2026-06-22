import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/tasks/task-audio.js"), "utf8");
const audioModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

class FakeAudio {
    static instances = [];

    constructor(src) {
        this.src = src;
        this.listeners = new Map();
        this.playResult = Promise.resolve();
        FakeAudio.instances.push(this);
    }

    addEventListener(name, callback) {
        this.listeners.set(name, callback);
    }

    removeEventListener(name) {
        this.listeners.delete(name);
    }

    removeAttribute(name) {
        if (name === "src") this.src = "";
    }

    load() {}
    pause() { this.paused = true; }
    play() { return this.playResult; }

    finish(name = "ended") {
        this.listeners.get(name)?.({ currentTarget: this });
    }
}

test.beforeEach(() => {
    FakeAudio.instances = [];
});

test("task sounds allocate lazily, overlap, and release after playback", async () => {
    const sounds = audioModule.createTaskSounds({
        completeSound: "/complete.mp3",
        uncompleteSound: "/uncomplete.mp3",
        AudioConstructor: FakeAudio,
    });
    assert.equal(FakeAudio.instances.length, 0);

    assert.equal(await sounds.playComplete(), true);
    assert.equal(await sounds.playComplete(), true);
    assert.equal(FakeAudio.instances.length, 2);
    assert.equal(FakeAudio.instances[0].volume, 0.55);

    FakeAudio.instances[0].finish();
    assert.equal(FakeAudio.instances[0].src, "");
    sounds.dispose();
    assert.equal(FakeAudio.instances[1].paused, true);
    assert.equal(FakeAudio.instances[1].src, "");
});

test("disabled task sounds do not allocate audio", async () => {
    const sounds = audioModule.createTaskSounds({ completeSound: "/complete.mp3", AudioConstructor: FakeAudio });
    assert.equal(await sounds.playComplete(false), false);
    assert.equal(FakeAudio.instances.length, 0);
});

test("playback failures are contained and release audio", async () => {
    class FailingAudio extends FakeAudio {
        play() { return Promise.reject(new Error("blocked")); }
    }
    const player = audioModule.createLazyAudioPlayer("/complete.mp3", FailingAudio);
    assert.equal(await player.play(), false);
    assert.equal(player.activeCount(), 0);
    assert.equal(FakeAudio.instances[0].src, "");
});
