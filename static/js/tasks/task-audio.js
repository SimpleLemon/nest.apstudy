export function createLazyAudioPlayer(src, AudioConstructor = globalThis.Audio) {
    const active = new Set();

    function release(audio) {
        if (!active.delete(audio)) return;
        audio.removeEventListener?.("ended", onFinished);
        audio.removeEventListener?.("error", onFinished);
        audio.removeAttribute?.("src");
        audio.load?.();
    }

    function onFinished(event) {
        release(event.currentTarget);
    }

    function play({ volume = 1, playbackRate = 1 } = {}) {
        if (!src || typeof AudioConstructor !== "function") return Promise.resolve(false);
        const audio = new AudioConstructor(src);
        audio.preload = "none";
        audio.volume = volume;
        audio.playbackRate = playbackRate;
        active.add(audio);
        audio.addEventListener?.("ended", onFinished);
        audio.addEventListener?.("error", onFinished);

        let playback;
        try {
            playback = audio.play?.();
        } catch (_error) {
            release(audio);
            return Promise.resolve(false);
        }
        return Promise.resolve(playback)
            .then(() => true)
            .catch(() => {
                release(audio);
                return false;
            });
    }

    function dispose() {
        for (const audio of [...active]) {
            audio.pause?.();
            release(audio);
        }
    }

    return { play, dispose, activeCount: () => active.size };
}

export function createTaskSounds({ completeSound, uncompleteSound, AudioConstructor } = {}) {
    const complete = createLazyAudioPlayer(completeSound, AudioConstructor);
    const uncomplete = createLazyAudioPlayer(uncompleteSound, AudioConstructor);
    return {
        playComplete: (enabled = true) => enabled ? complete.play({ volume: 0.55 }) : Promise.resolve(false),
        playUncomplete: (enabled = true) => enabled ? uncomplete.play({ volume: 0.35, playbackRate: 0.86 }) : Promise.resolve(false),
        dispose() {
            complete.dispose();
            uncomplete.dispose();
        },
    };
}
