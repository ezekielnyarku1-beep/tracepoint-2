async function setupDashboardMenu() {
    if (document.getElementById("app-sidebar")) return;

    const header = document.querySelector("body > header");
    const navigation = document.querySelector("body > nav");
    const main = document.querySelector("body > main");
    if (!header || !navigation || !main) return;
    const isDashboardPage = main.matches(".dashboard-main") || main.dataset.page === "dashboard";
    if (isDashboardPage) document.body.classList.add("dashboard-page");

    const sidebar = document.createElement("aside");
    sidebar.className = "app-sidebar";
    sidebar.id = "app-sidebar";
    sidebar.setAttribute("aria-label", "Application sidebar");
    sidebar.append(header, navigation);
    document.body.insertBefore(sidebar, main);
    navigation.id = "main-navigation";

    const pageTitle = main.querySelector("h2");
    if (!pageTitle) return;
    let heading = pageTitle.parentElement;

    const overlay = document.createElement("button");
    overlay.className = "app-sidebar-overlay";
    overlay.type = "button";
    overlay.setAttribute("aria-label", "Close navigation menu");
    overlay.setAttribute("aria-hidden", "true");
    overlay.tabIndex = -1;
    document.body.insertBefore(overlay, main);

    const menuButton = document.createElement("button");
    menuButton.className = "app-menu-toggle";
    menuButton.id = "app-menu-toggle";
    menuButton.type = "button";
    menuButton.setAttribute("aria-controls", sidebar.id);
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Toggle menu");
    menuButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
    `;

    const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
    let previousMobileState = isMobile();
    const isMobileExpanded = () => document.body.classList.contains("sidebar-open");
    const setMenuButtonState = (expanded, expandedLabel, collapsedLabel) => {
        menuButton.setAttribute("aria-expanded", String(expanded));
        menuButton.setAttribute("aria-label", expanded ? expandedLabel : collapsedLabel);
        menuButton.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
        `;
    };

    const setMobileMenu = (open, restoreFocus = false) => {
        document.body.classList.toggle("sidebar-open", open);
        sidebar.inert = !open;
        sidebar.setAttribute("aria-hidden", String(!open));
        setMenuButtonState(open, "Close navigation menu", "Open navigation menu");
        overlay.setAttribute("aria-hidden", String(!open));
        if (open) {
            navigation.querySelector("ul a")?.focus({ preventScroll: true });
        } else if (restoreFocus) {
            menuButton.focus({ preventScroll: true });
        }
    };

    const updateState = () => {
        const mobile = isMobile();
        heading.prepend(menuButton);
        if (mobile !== previousMobileState) {
            document.body.classList.remove("sidebar-open", "sidebar-collapsed");
            previousMobileState = mobile;
        }
        if (mobile) {
            const expanded = isMobileExpanded();
            sidebar.inert = !expanded;
            sidebar.setAttribute("aria-hidden", String(!expanded));
            overlay.setAttribute("aria-hidden", String(!expanded));
            setMenuButtonState(expanded, "Close navigation menu", "Open navigation menu");
        } else {
            document.body.classList.remove("sidebar-open");
            sidebar.inert = false;
            sidebar.removeAttribute("aria-hidden");
            overlay.setAttribute("aria-hidden", "true");
            const expanded = !document.body.classList.contains("sidebar-collapsed");
            setMenuButtonState(expanded, "Collapse navigation menu", "Expand navigation menu");
        }
    };

    menuButton.addEventListener("click", () => {
        updateState();
        if (isMobile()) {
            setMobileMenu(!isMobileExpanded());
        } else {
            document.body.classList.toggle("sidebar-collapsed");
            updateState();
        }
    });
    overlay.addEventListener("click", () => setMobileMenu(false, true));
    navigation.addEventListener("click", (event) => {
        if (isMobile() && event.target instanceof Element && event.target.closest("a")) {
            setMobileMenu(false, true);
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && isMobile() && isMobileExpanded()) {
            setMobileMenu(false, true);
        }
    });
    window.addEventListener("resize", updateState);
    updateState();

    const { APP_PAGES, hasPageAccess } = await import("./page-config.js");
    if (!window.pathfinderProfile?.profile) {
        if (window.pathfinderProfileError || window.pathfinderAuthError) return;
    }
    const profile = await new Promise((resolve) => {
        if (window.pathfinderProfile?.profile) {
            resolve(window.pathfinderProfile.profile);
            return;
        }
        document.addEventListener("pathfinder:profile-ready", (event) => {
            resolve(event.detail.profile);
        }, { once: true });
        document.addEventListener("pathfinder:profile-error", () => resolve(null), { once: true });
        document.addEventListener("pathfinder:auth-error", () => resolve(null), { once: true });
    });
    if (!profile) return;
    const nestedAppPage = /\/\.vscode\//i.test(window.location.pathname);
    const entries = APP_PAGES.filter((page) => hasPageAccess(profile, page.key));
    const list = navigation.querySelector("ul") || navigation.appendChild(document.createElement("ul"));
    list.replaceChildren();
    const pageItems = new Map();
    const currentFile = window.location.pathname.split("/").pop().toLowerCase();
    const currentEntry = entries.find((entry) => entry.fileName.toLowerCase() === currentFile);

    entries.forEach((entry) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = nestedAppPage
            ? entry.key === "account" ? "account.html" : `../${entry.fileName}`
            : entry.key === "account" ? ".vscode/account.html" : entry.fileName;
        if (currentEntry === entry) link.setAttribute("aria-current", "page");
        if (entry.key === "account") {
            link.innerHTML = `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
                </svg>
                <span>${entry.label}</span>
            `;
        } else {
            link.textContent = entry.label;
        }
        item.append(link);
        list.append(item);
        pageItems.set(entry.key, item);
    });

    const accountLink = [...navigation.querySelectorAll("a")]
        .find((link) => link.textContent.trim().toLowerCase() === "my account");
    const accountItem = pageItems.get("account");
    const accountSubmenu = document.createElement("ul");
    accountSubmenu.className = "app-account-submenu";
    accountSubmenu.setAttribute("aria-label", "Account management");
    for (const pageKey of ["users", "roles"]) {
        const pageItem = pageItems.get(pageKey);
        if (pageItem) accountSubmenu.append(pageItem);
    }
    if (accountSubmenu.childElementCount) accountItem.append(accountSubmenu);
    const isAccountPage = currentEntry?.key === "account";
    const existingSignoutLinks = [...navigation.querySelectorAll("a")]
        .filter((link) => link.textContent.trim().toLowerCase() === "sign out");
    let signoutLink = existingSignoutLinks.shift();
    existingSignoutLinks.forEach((link) => link.remove());
    if (isDashboardPage || !isAccountPage) {
        signoutLink?.remove();
        signoutLink = null;
    } else if (!signoutLink) {
        signoutLink = document.createElement("a");
        signoutLink.className = "nav-signout";
        signoutLink.href = nestedAppPage ? "signout.html" : ".vscode/signout.html";
        signoutLink.textContent = "Sign out";
    }

    const userActions = document.createElement("div");
    userActions.className = "app-user-actions";

    accountLink.classList.add("app-account-link");
    accountLink.parentElement.classList.add("app-account-nav-item");

    const userIdentity = document.createElement("div");
    userIdentity.className = "app-user-identity";
    userIdentity.innerHTML = "<strong>INPATH</strong><span>IT / Systems Administrator</span>";

    const userButtons = document.createElement("div");
    userButtons.className = "app-user-buttons";
    if (signoutLink) userButtons.append(signoutLink);
    userActions.append(userIdentity);
    if (userButtons.childElementCount) userActions.append(userButtons);

    if (heading.classList.contains("dashboard-heading")) {
        const headingCopy = document.createElement("div");
        headingCopy.className = "app-heading-copy";
        headingCopy.append(...Array.from(heading.children));
        heading.prepend(menuButton);
        heading.append(headingCopy, userActions);
    } else if (
        pageTitle.parentElement?.classList.contains("app-heading-copy") &&
        pageTitle.parentElement.parentElement?.classList.contains("app-page-heading")
    ) {
        heading = pageTitle.parentElement.parentElement;
        heading.prepend(menuButton);
        heading.append(userActions);
    } else {
        const intro = pageTitle.nextElementSibling;
        const headingRow = document.createElement("div");
        const headingCopy = document.createElement("div");
        headingRow.className = "app-page-heading";
        let headingStart = pageTitle;
        while (headingStart.parentElement !== main) {
            headingStart = headingStart.parentElement;
        }
        main.insertBefore(headingRow, headingStart);
        headingCopy.className = "app-heading-copy";
        headingCopy.append(pageTitle);
        if (intro?.tagName === "P") headingCopy.append(intro);
        headingRow.append(menuButton, headingCopy, userActions);
        heading = headingRow;
    }

    updateState();
}

function setupNavigationPrefetch() {
    const navigation = document.querySelector("nav");
    if (!navigation) return;

    const prefetchedUrls = new Set();
    const prefetchPage = (link) => {
        if (
            link.matches(".nav-signout, [aria-current='page']") ||
            link.origin !== window.location.origin ||
            !link.pathname.endsWith(".html") ||
            prefetchedUrls.has(link.href)
        ) {
            return;
        }

        prefetchedUrls.add(link.href);
        const prefetch = document.createElement("link");
        prefetch.rel = "prefetch";
        prefetch.href = link.href;
        prefetch.as = "document";
        document.head.append(prefetch);
    };

    document.querySelectorAll("nav a, .app-user-actions a").forEach((link) => {
        link.addEventListener("pointerenter", () => prefetchPage(link), { once: true });
        link.addEventListener("focus", () => prefetchPage(link), { once: true });
    });
}

setupDashboardMenu().then(setupNavigationPrefetch).catch((error) => {
    console.error("Could not build the application navigation.", error);
});
