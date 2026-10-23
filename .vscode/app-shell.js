function setupDashboardMenu() {
    if (document.getElementById("app-sidebar")) return;

    const header = document.querySelector("body > header");
    const navigation = document.querySelector("body > nav");
    const main = document.querySelector("body > main");
    const pageTitle = main?.querySelector("h2");
    if (!header || !navigation || !main || !pageTitle) return;

    const nestedAppPage = /\/\.vscode\//i.test(window.location.pathname);
    const entries = [
        { label: "Dashboard", file: "index.html" },
        { label: "Kiosks", file: "kiosks.html" },
        { label: "Components", file: "components.html" },
        { label: "Log an Event", file: "log-event.html" },
        { label: "Fault History", file: "fault-history.html" },
        { label: "Alerts", file: "alerts.html" },
        { label: "Reports", file: "reports.html" },
        { label: "Users", file: "users.html" },
        { label: "Audit Log", file: "audit-log.html" },
        { label: "My account", file: "account.html", account: true }
    ];
    const list = navigation.querySelector("ul") || navigation.appendChild(document.createElement("ul"));
    const existingItems = [...list.querySelectorAll(":scope > li")];
    const normalizeLabel = (link) => link.textContent.trim().replace(/\s+/g, " ").toLowerCase();
    const itemByLabel = new Map();
    existingItems.forEach((item) => {
        const link = item.querySelector("a");
        if (link) itemByLabel.set(normalizeLabel(link), item);
    });
    const currentFile = window.location.pathname.split("/").pop().toLowerCase();
    const currentEntry = currentFile === "index.html"
        ? entries[0]
        : entries.find((entry) => entry.file.toLowerCase() === currentFile);

    entries.forEach((entry) => {
        let item = itemByLabel.get(entry.label.toLowerCase());
        if (!item) {
            item = document.createElement("li");
            item.append(document.createElement("a"));
        }
        const link = item.querySelector("a");
        link.href = nestedAppPage
            ? entry.account ? "account.html" : `../${entry.file}`
            : entry.account ? ".vscode/account.html" : entry.file;
        if (currentEntry === entry) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
        if (!link.querySelector("span") && entry.account) {
            link.innerHTML = `
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
                </svg>
                <span>My account</span>
            `;
        } else if (entry.account) {
            const label = link.querySelector("span");
            if (label) label.textContent = "My account";
        } else {
            link.textContent = entry.label;
        }
        list.append(item);
    });

    const sidebar = document.createElement("aside");
    sidebar.className = "app-sidebar";
    sidebar.id = "app-sidebar";
    sidebar.setAttribute("aria-label", "Application sidebar");
    sidebar.append(header, navigation);
    document.body.insertBefore(sidebar, main);
    navigation.id = "main-navigation";

    const accountLink = [...navigation.querySelectorAll("a")]
        .find((link) => normalizeLabel(link) === "my account");
    const isAccountPage = currentEntry?.account === true;
    const existingSignoutLinks = [...navigation.querySelectorAll("a")]
        .filter((link) => link.textContent.trim().toLowerCase() === "sign out");
    let signoutLink = existingSignoutLinks.shift();
    existingSignoutLinks.forEach((link) => link.remove());
    if (!isAccountPage) {
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

    const heading = pageTitle.parentElement;
    if (heading.classList.contains("dashboard-heading")) {
        const headingCopy = document.createElement("div");
        headingCopy.className = "app-heading-copy";
        headingCopy.append(...Array.from(heading.children));
        heading.prepend(menuButton);
        heading.append(headingCopy, userActions);
    } else {
        const intro = pageTitle.nextElementSibling;
        const headingRow = document.createElement("div");
        const headingCopy = document.createElement("div");
        headingRow.className = "app-page-heading";
        main.insertBefore(headingRow, pageTitle);
        headingCopy.className = "app-heading-copy";
        headingCopy.append(pageTitle);
        if (intro?.tagName === "P") headingCopy.append(intro);
        headingRow.append(menuButton, headingCopy, userActions);
    }

    const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
    let previousMobileState = isMobile();
    const isMobileExpanded = () => document.body.classList.contains("sidebar-open");

    const setMobileMenu = (open, restoreFocus = false) => {
        document.body.classList.toggle("sidebar-open", open);
        sidebar.inert = !open;
        sidebar.setAttribute("aria-hidden", String(!open));
        menuButton.setAttribute("aria-expanded", String(open));
        overlay.setAttribute("aria-hidden", String(!open));
        if (open) {
            navigation.querySelector("ul a")?.focus({ preventScroll: true });
        } else if (restoreFocus) {
            menuButton.focus({ preventScroll: true });
        }
    };

    const updateState = () => {
        const mobile = isMobile();
        if (mobile !== previousMobileState) {
            document.body.classList.remove("sidebar-open", "sidebar-collapsed");
            previousMobileState = mobile;
        }
        if (mobile) {
            const expanded = isMobileExpanded();
            sidebar.inert = !expanded;
            sidebar.setAttribute("aria-hidden", String(!expanded));
            overlay.setAttribute("aria-hidden", String(!expanded));
            menuButton.setAttribute("aria-expanded", String(expanded));
        } else {
            document.body.classList.remove("sidebar-open");
            sidebar.inert = false;
            sidebar.removeAttribute("aria-hidden");
            overlay.setAttribute("aria-hidden", "true");
            menuButton.setAttribute(
                "aria-expanded",
                String(!document.body.classList.contains("sidebar-collapsed"))
            );
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

setupDashboardMenu();
setupNavigationPrefetch();
