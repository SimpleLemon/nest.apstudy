(() => {
    if (window.APStudyBreadcrumb) return;

    let activeEllipsisMenu = null;
    let activeEllipsisTrigger = null;

    function defaultEscapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function separatorHtml() {
        return `<li class="breadcrumb-separator" role="presentation" aria-hidden="true"><span class="material-symbols-outlined" aria-hidden="true">chevron_right</span></li>`;
    }

    function linkItemHtml(item, escapeHtml) {
        const label = escapeHtml(item.label ?? "");
        if (item.href) {
            return `<li class="breadcrumb-item"><a class="breadcrumb-link" href="${escapeHtml(item.href)}">${label}</a></li>`;
        }
        const id = escapeHtml(item.id ?? "");
        return `<li class="breadcrumb-item"><button type="button" class="breadcrumb-link" data-breadcrumb-id="${id}">${label}</button></li>`;
    }

    function pageItemHtml(item, escapeHtml) {
        return `<li class="breadcrumb-item"><span class="breadcrumb-page" aria-current="page">${escapeHtml(item.label ?? "")}</span></li>`;
    }

    function ellipsisItemHtml(escapeHtml) {
        return `<li class="breadcrumb-item"><button type="button" class="breadcrumb-ellipsis" aria-haspopup="menu" aria-expanded="false" aria-label="Show more path segments"><span class="material-symbols-outlined" aria-hidden="true">more_horiz</span><span class="sr-only">More</span></button></li>`;
    }

    function closeEllipsisMenu() {
        if (activeEllipsisMenu) {
            activeEllipsisMenu.hidden = true;
            activeEllipsisMenu.remove();
            activeEllipsisMenu = null;
        }
        if (activeEllipsisTrigger) {
            activeEllipsisTrigger.setAttribute("aria-expanded", "false");
            activeEllipsisTrigger = null;
        }
    }

    function positionEllipsisMenu(trigger, menu) {
        const rect = trigger.getBoundingClientRect();
        const gap = 8;
        menu.hidden = false;
        const menuRect = menu.getBoundingClientRect();
        let top = rect.bottom + gap;
        let left = rect.left;
        if (top + menuRect.height > window.innerHeight - gap) {
            top = Math.max(gap, rect.top - menuRect.height - gap);
        }
        if (left + menuRect.width > window.innerWidth - gap) {
            left = window.innerWidth - menuRect.width - gap;
        }
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }

    function openEllipsisMenu(trigger, middleItems, escapeHtml, onNavigate) {
        closeEllipsisMenu();
        const menu = document.createElement("ul");
        menu.className = "breadcrumb-ellipsis-menu";
        menu.setAttribute("role", "menu");
        menu.innerHTML = middleItems.map((item) => (
            `<li role="none"><button type="button" role="menuitem" data-breadcrumb-id="${escapeHtml(item.id ?? "")}">${escapeHtml(item.label ?? "")}</button></li>`
        )).join("");
        document.body.appendChild(menu);
        activeEllipsisMenu = menu;
        activeEllipsisTrigger = trigger;
        trigger.setAttribute("aria-expanded", "true");
        positionEllipsisMenu(trigger, menu);
        menu.querySelectorAll("[data-breadcrumb-id]").forEach((button) => {
            button.addEventListener("click", () => {
                closeEllipsisMenu();
                onNavigate?.(button.dataset.breadcrumbId);
            });
        });
        menu.querySelector("button")?.focus({ preventScroll: true });
    }

    function resolveVisibleItems(items, collapseAfter) {
        if (items.length <= collapseAfter) return items;
        const first = items[0];
        const parent = items[items.length - 2];
        const current = items[items.length - 1];
        const middle = items.slice(1, -2);
        return { first, middle, parent, current, collapsed: true };
    }

    function renderBreadcrumb(container, items, options = {}) {
        if (!container || !Array.isArray(items) || !items.length) return;

        const escapeHtml = typeof options.escapeHtml === "function" ? options.escapeHtml : defaultEscapeHtml;
        const collapseAfter = Number(options.collapseAfter) || 4;
        const onNavigate = typeof options.onNavigate === "function" ? options.onNavigate : null;

        closeEllipsisMenu();

        const resolved = resolveVisibleItems(items, collapseAfter);
        const parts = [];

        if (resolved.collapsed) {
            parts.push(linkItemHtml(resolved.first, escapeHtml));
            parts.push(separatorHtml());
            parts.push(ellipsisItemHtml(escapeHtml));
            parts.push(separatorHtml());
            parts.push(linkItemHtml(resolved.parent, escapeHtml));
            parts.push(separatorHtml());
            parts.push(pageItemHtml(resolved.current, escapeHtml));
        } else {
            items.forEach((item, index) => {
                if (index > 0) parts.push(separatorHtml());
                if (index === items.length - 1 || item.current) {
                    parts.push(pageItemHtml(item, escapeHtml));
                } else {
                    parts.push(linkItemHtml(item, escapeHtml));
                }
            });
        }

        container.innerHTML = `<ol class="breadcrumb-list">${parts.join("")}</ol>`;

        container.querySelectorAll(".breadcrumb-link[data-breadcrumb-id]").forEach((button) => {
            button.addEventListener("click", () => onNavigate?.(button.dataset.breadcrumbId));
        });

        const ellipsisTrigger = container.querySelector(".breadcrumb-ellipsis");
        if (ellipsisTrigger && resolved.collapsed) {
            ellipsisTrigger.addEventListener("click", (event) => {
                event.stopPropagation();
                if (activeEllipsisTrigger === ellipsisTrigger && activeEllipsisMenu) {
                    closeEllipsisMenu();
                    return;
                }
                openEllipsisMenu(ellipsisTrigger, resolved.middle, escapeHtml, onNavigate);
            });
        }
    }

    document.addEventListener("click", (event) => {
        if (!activeEllipsisMenu) return;
        if (activeEllipsisMenu.contains(event.target) || activeEllipsisTrigger?.contains(event.target)) return;
        closeEllipsisMenu();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeEllipsisMenu();
    });

    window.addEventListener("resize", closeEllipsisMenu);
    window.addEventListener("scroll", closeEllipsisMenu, true);

    window.APStudyBreadcrumb = {
        renderBreadcrumb,
        closeEllipsisMenu,
    };
})();
