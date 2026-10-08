export async function openSidebarHarness(page, baseURL, { sidebarDefault = "expanded" } = {}) {
    await page.route("**/sidebar-interactions-harness", route => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head>
            <link rel="stylesheet" href="/static/css/themes.css">
            <link rel="stylesheet" href="/static/css/global.css">
            <link rel="stylesheet" href="/static/css/layout.css">
            <script>window.APSTUDY_SIDEBAR_DEFAULT = ${JSON.stringify(sidebarDefault)}</script>
            <script src="/static/js/core/sidebar-init.js"></script>
        </head><body>
            <global class="thenav" data-authenticated="false" data-user-email="harness@example.test"></global>
            <nav class="sidebar-container" id="sidebar-root" aria-label="Primary navigation" data-sidebar-default="${sidebarDefault}">
                <div class="sidebar-scroll"><div class="sidebar-content">
                    <a href="#workspace" class="sidebar-item" aria-label="Dashboard"><span class="sidebar-item-label">Dashboard</span></a>
                    <a href="#chat" class="sidebar-item" aria-label="Chat"><span class="sidebar-item-label">Chat</span><span class="sidebar-chat-badge" data-chat-unread-badge hidden></span></a>
                </div></div>
                <button class="sidebar-toggle-handle" id="sidebar-toggle-handle" type="button" aria-label="Toggle sidebar">
                    <span class="sidebar-toggle-icon" aria-hidden="true"></span><span class="sidebar-toggle-tooltip">Collapse</span>
                </button>
            </nav>
            <div class="sidebar-tooltip" id="sidebar-tooltip"></div>
            <div class="sidebar-mobile-backdrop" id="sidebar-mobile-backdrop" hidden></div>
            <main id="workspace"><button id="workspace-control">Workspace control</button></main>
            <script src="/static/js/core/navbar.js"></script>
            <script src="/static/js/core/sidebar.js"></script>
        </body></html>`,
    }));
    await page.route("**/api/chat/summary", route => route.fulfill({
        contentType: "application/json", body: JSON.stringify({ total_unread: 0 }),
    }));
    await page.goto(`${baseURL}/sidebar-interactions-harness`, { waitUntil: "networkidle" });
}
