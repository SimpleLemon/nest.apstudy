
export function createReviewRuntime({
    noteId,
    reviewPanel,
    reviewButton,
    historyButton,
    loadModule = () => import('./review-panel.js'),
}) {
    /** @type {import('./review-contracts.js').ReviewPanelController|null} */
    let reviewPanelController = null;
    let reviewPanelModulePromise = null;
    let reviewPanelBootstrapCleanup = null;
    let disposed = false;
    let permissionsKey = null;
    let generation = 0;

    function releaseController() {
        if (reviewPanelController?.destroy) reviewPanelController.destroy();
        else reviewPanelController?.close?.();
        reviewPanelController = null;
    }

    function reset() {
        if (disposed) return;
        permissionsKey = null;
        generation += 1;
        reviewPanelBootstrapCleanup?.();
        reviewPanelBootstrapCleanup = null;
        releaseController();
        reviewButton?.removeAttribute('aria-busy');
        historyButton?.removeAttribute('aria-busy');
    }

    function invalidate(event) {
        if (disposed || !String(event?.type || '').startsWith('review.')) return;
        // Opening a lazy or closed panel always fetches current activity. An
        // already mounted panel owns its pending requests and refresh queue.
        void reviewPanelController?.refresh?.();
    }

    function bindLazyReviewPanel({ canReview, canManageReviews, canViewVersions }) {
        if (disposed) return;
        const nextKey = JSON.stringify([canReview === true, canManageReviews === true, canViewVersions === true]);
        if (permissionsKey === nextKey) return;
        reset();
        permissionsKey = nextKey;
        const bindingGeneration = ++generation;
        if (reviewButton) reviewButton.disabled = canReview !== true;
        if (historyButton) historyButton.disabled = canViewVersions !== true;
        if (!noteId || !reviewPanel) return;

        const openPanel = async (mode) => {
            if (bindingGeneration !== generation || (mode === 'history' ? !canViewVersions : !canReview)) return;
            reviewButton?.setAttribute('aria-busy', 'true');
            historyButton?.setAttribute('aria-busy', 'true');
            try {
                reviewPanelModulePromise ||= loadModule().catch((error) => {
                    reviewPanelModulePromise = null;
                    throw error;
                });
                const { bindReviewPanel } = await reviewPanelModulePromise;
                if (disposed || bindingGeneration !== generation) return;
                if (!reviewPanelController) {
                    reviewPanelController = bindReviewPanel({
                        noteId,
                        canReview,
                        canManageReviews,
                        canViewVersions,
                        panel: reviewPanel,
                        reviewButton: null,
                        historyButton: null,
                        toast: window.APStudyToast,
                    });
                }
                await reviewPanelController?.open?.(mode);
            } catch (error) {
                if (disposed || bindingGeneration !== generation) return;
                console.error('Failed to load note review panel', error);
                window.APStudyToast?.error?.('Try again in a moment.', { title: 'Couldn’t load review tools' });
            } finally {
                if (bindingGeneration === generation) {
                    reviewButton?.removeAttribute('aria-busy');
                    historyButton?.removeAttribute('aria-busy');
                }
            }
        };
        const openReview = () => { void openPanel('review'); };
        const openHistory = () => { void openPanel('history'); };
        reviewButton?.addEventListener('click', openReview);
        historyButton?.addEventListener('click', openHistory);
        reviewPanelBootstrapCleanup = () => {
            reviewButton?.removeEventListener('click', openReview);
            historyButton?.removeEventListener('click', openHistory);
        };
    }

    function dispose() {
        if (disposed) return;
        reset();
        disposed = true;
        reviewButton?.removeAttribute('aria-busy');
        historyButton?.removeAttribute('aria-busy');
    }

    return {
        bind: bindLazyReviewPanel,
        invalidate,
        reset,
        dispose,
    };
}
