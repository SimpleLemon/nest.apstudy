// This status is only a prompt to re-read authenticated connection state.
if (window.opener) {
    window.opener.postMessage({ type: "apstudy-calendar-connected", result: document.body.dataset.result }, "*");
    window.close();
}
