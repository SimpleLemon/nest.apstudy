export function bindCollaborativeTitle({ session, fallbackTitle, titleInput, getCanEdit }) {
    if (!session || !titleInput) return null;
    const yTitle = session.document.getText('title');
    let applyingRemoteTitle = false;
    let active = true;
    let initialized = false;
    const applyRemoteTitle = () => {
        if (!active) return;
        const nextTitle = yTitle.toString();
        if (titleInput.value === nextTitle) return;
        applyingRemoteTitle = true;
        titleInput.value = nextTitle;
        applyingRemoteTitle = false;
    };
    const maybeInitializeTitle = () => {
        if (!active || !session.ready) return;
        if (!initialized && getCanEdit() && yTitle.length === 0 && fallbackTitle) {
            yTitle.insert(0, fallbackTitle);
        }
        if (getCanEdit() || yTitle.length > 0) initialized = true;
        applyRemoteTitle();
    };
    const handleTitleInput = () => {
        if (!active || !session.ready || applyingRemoteTitle || !getCanEdit()) return;
        const nextTitle = titleInput.value;
        session.document.transact(() => {
            yTitle.delete(0, yTitle.length);
            yTitle.insert(0, nextTitle);
        });
    };
    yTitle.observe(applyRemoteTitle);
    const handleSynced = ({ state }) => {
        if (state) maybeInitializeTitle();
    };
    session.provider.on?.('synced', handleSynced);
    const unsubscribeAccess = session.subscribeAccess?.(maybeInitializeTitle);
    titleInput.addEventListener('input', handleTitleInput);
    if (session.ready) maybeInitializeTitle();
    return () => {
        active = false;
        session.provider.off?.('synced', handleSynced);
        unsubscribeAccess?.();
        yTitle.unobserve(applyRemoteTitle);
        titleInput.removeEventListener('input', handleTitleInput);
    };
}
