import {
    ROLES,
    escapeHtml,
    findComponentBySerial,
    findKioskByLocation,
    formatDate,
    formatDateOnly,
    getAssignedComponentCount,
    getAlertCountSummary,
    getDocumentCount,
    loadAssignedPage,
    loadComponent,
    loadComponentEvents,
    loadKiosk,
    loadPage,
    loadRecent,
    loadRecentPage,
    recordFault,
    registerComponent,
    registerKiosk,
    resolveConflict,
    resolveFault,
    updateComponent,
    updateKiosk,
    updateUserPermissions,
    updateUserRole
} from "./data-service.js";
import { GRANTABLE_PAGES, hasPageAccess } from "./page-config.js";
import {
    collection,
    doc,
    getCountFromServer,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    startAfter,
    startAt,
    where
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { db } from "./firebase-client.js";

const main = document.querySelector("main[data-page]");
let context = null;
let started = false;

function setStatus(message, isError = false) {
    const status = document.getElementById("data-page-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = message ? (isError ? "error" : "success") : "";
}

function showPage(title, description, body) {
    let heading = main.querySelector(":scope > .app-page-heading, :scope > .dashboard-heading");
    let headingCopy = heading?.querySelector(".app-heading-copy");
    if (!heading) {
        const existingTitle = main.querySelector(":scope > h2");
        if (existingTitle) {
            const existingDescription = existingTitle.nextElementSibling?.tagName === "P"
                ? existingTitle.nextElementSibling
                : null;
            heading = document.createElement("div");
            heading.className = "app-page-heading";
            headingCopy = document.createElement("div");
            headingCopy.className = "app-heading-copy";
            headingCopy.append(existingTitle);
            if (existingDescription) headingCopy.append(existingDescription);
            heading.append(headingCopy);
        }
    }

    const headingContent = headingCopy || heading;
    if (headingContent) {
        let pageTitle = headingContent.querySelector(":scope > h2");
        if (!pageTitle) {
            pageTitle = document.createElement("h2");
            headingContent.prepend(pageTitle);
        }
        pageTitle.textContent = title;

        let pageDescription = headingContent.querySelector(":scope > p");
        if (!pageDescription) {
            pageDescription = document.createElement("p");
            headingContent.append(pageDescription);
        }
        pageDescription.textContent = description;
    }

    main.innerHTML = `
        <p class="data-page-status" id="data-page-status" role="status" aria-live="polite"></p>
        ${body}`;
    if (heading) main.prepend(heading);
}

function showProfileError(error) {
    const description = error?.code === "permission-denied"
        ? "Firestore denied access to your account profile. Confirm the deployed rules allow signed-in users to read and create their own users/{uid} profile."
        : !navigator.onLine || ["unavailable", "network-request-failed"].includes(error?.code)
            ? "Could not reach Firestore to verify your account profile. Check your connection and try again."
            : error?.message || "Could not verify your account profile. Check your Firestore configuration and rules.";
    showPage("Unable to load data", description, `<section><p>Your account profile could not be verified, so protected data remains unavailable.</p></section>`);
}

function showAuthError(error) {
    const description = !navigator.onLine || error?.code === "auth/network-request-failed"
        ? "Could not reach Firebase Authentication. Check your connection and try again."
        : error?.message || "Could not verify your sign-in with Firebase Authentication.";
    showPage("Unable to verify sign-in", description, `<section><p>Protected data remains unavailable until Firebase confirms your sign-in.</p></section>`);
}

function createTable(headers, rows, emptyMessage) {
    return `<div class="data-table-wrap"><table>
        <thead><tr>${headers.map((header) => `<th scope="col">${header}</th>`).join("")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length}">${emptyMessage}</td></tr>`}</tbody>
    </table></div>`;
}

function pageControls(container, page, next) {
    container.replaceChildren();
    if (!page.hasMore) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "data-load-more";
    button.textContent = "Load more";
    button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Loading…";
        try {
            await next(page.cursor);
        } catch (error) {
            setStatus(error.message || "Could not load more records.", true);
            button.disabled = false;
            button.textContent = "Try again";
        }
    });
    container.append(button);
}

function installLoadControl(page, callback) {
    pageControls(document.getElementById("data-load-more"), page, callback);
}

function cellText(value) {
    return escapeHtml(value || "—");
}

function fieldValue(value) {
    return escapeHtml(value ?? "");
}

function componentAlertRecords(components) {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const warnings = [];
    for (const component of components) {
        const warrantyDate = component.warrantyExpiry
            ? new Date(`${component.warrantyExpiry}T00:00:00Z`)
            : null;
        if (warrantyDate && !Number.isNaN(warrantyDate.getTime())) {
            const days = Math.ceil((warrantyDate - now) / 86400000);
            if (days < 0) {
                warnings.push({
                    date: component.warrantyExpiry,
                    asset: component.id,
                    message: "Warranty expired",
                    status: "Expired"
                });
            } else if (days <= 30) {
                warnings.push({
                    date: component.warrantyExpiry,
                    asset: component.id,
                    message: "Warranty expires soon",
                    status: `${days} day${days === 1 ? "" : "s"}`
                });
            }
        }
        const months = Number(component.serviceLifeMonths || 0);
        if (months > 0 && component.purchaseDate) {
            const expiryDate = component.serviceLifeExpiry || calculateServiceExpiry(component.purchaseDate, months);
            const expiry = new Date(`${expiryDate}T00:00:00Z`);
            if (!Number.isNaN(expiry.getTime())) {
                const days = Math.ceil((expiry - now) / 86400000);
                if (days < 0) {
                    warnings.push({
                        date: expiryDate,
                        asset: component.id,
                        message: "Expected service life exceeded",
                        status: "Due"
                    });
                } else if (days <= 30) {
                    warnings.push({
                        date: expiryDate,
                        asset: component.id,
                        message: "Expected service life ending soon",
                        status: `${days} day${days === 1 ? "" : "s"}`
                    });
                }
            }
        }
    }
    return warnings;
}

function calculateServiceExpiry(purchaseDate, months) {
    const [year, month, day] = purchaseDate.split("-").map(Number);
    const expiry = new Date(Date.UTC(year, month - 1, 1));
    expiry.setUTCMonth(expiry.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
    expiry.setUTCDate(Math.min(day, lastDay));
    return expiry.toISOString().slice(0, 10);
}

function setupDashboard() {
    showPage("Dashboard", "Monitor your inventory, faults, and recent component activity.", `
        <section class="dashboard-section" aria-labelledby="dashboard-overview">
            <h3 id="dashboard-overview">Overview</h3>
            <div class="dashboard-stats">
                <div class="dashboard-stat"><span>Total Kiosks</span><strong id="stat-kiosks">Loading…</strong></div>
                <div class="dashboard-stat"><span>Total Components</span><strong id="stat-components">Loading…</strong></div>
                <div class="dashboard-stat"><span>Active Alerts</span><strong id="stat-alerts">Loading…</strong></div>
                <div class="dashboard-stat"><span>Reported Faults</span><strong id="stat-faults">Loading…</strong></div>
            </div>
        </section>
        <section class="dashboard-section" aria-labelledby="dashboard-recent"><h3 id="dashboard-recent">Recent Activity</h3>
            <div id="recent-activity">${createTable(["Event", "Asset", "Date"], "", "Loading recent activity…")}</div>
        </section>`);
    const stats = [
        ["stat-kiosks", getDocumentCount("kiosks")],
        ["stat-components", getDocumentCount("components")],
        ["stat-alerts", getAlertCountSummary(context.profile)],
        ["stat-faults", getDocumentCount("faults")]
    ];
    stats.forEach(([id, request]) => {
        request.then((value) => {
            const stat = document.getElementById(id);
            if (stat) stat.textContent = value;
        }).catch((error) => {
            const stat = document.getElementById(id);
            if (stat) stat.textContent = "—";
            setStatus(error.message || "Could not load dashboard data.", true);
        });
    });
    loadRecent("events", 10).then((events) => {
        const rows = events.map((item) =>
            `<tr><td>${cellText(item.eventType)} — ${cellText(item.summary)}</td><td>${cellText(item.componentId || item.kioskId)}</td><td>${cellText(formatDate(item.createdAt))}</td></tr>`
        ).join("");
        const recentActivity = document.getElementById("recent-activity");
        if (recentActivity) recentActivity.innerHTML =
            createTable(["Event", "Asset", "Date"], rows, "No recent activity yet.");
    }).catch((error) => setStatus(error.message || "Could not load dashboard data.", true));
}

async function setupComponents() {
    const canEdit = context.profile.role === "administrator";
    showPage("Components", "Register, search, and review components with their current assignment and lifecycle details.", `
        <section aria-labelledby="component-search-heading">
            <h3 id="component-search-heading">Find a component</h3>
            <form class="data-toolbar" id="component-search-form">
                <label for="component-search">Component ID or serial number</label>
                <input id="component-search" type="search" autocomplete="off">
                <button type="submit">Search</button>
                <button type="reset" class="data-secondary-button">Clear</button>
            </form>
        </section>
        <section aria-labelledby="component-register-heading">
            <h3 id="component-register-heading">Register a component</h3>
            <form class="data-form" id="component-form">
                <label>Component ID<input name="id" maxlength="128" required></label>
                <label>Type<input name="type" maxlength="80" required></label>
                <label>Serial number<input name="serialNumber" maxlength="128"></label>
                <label>Manufacturer<input name="manufacturer" maxlength="120"></label>
                <label>Model<input name="model" maxlength="120"></label>
                <label>Purchase date<input name="purchaseDate" type="date"></label>
                <label>Warranty start<input name="warrantyStart" type="date"></label>
                <label>Warranty expiry<input name="warrantyExpiry" type="date"></label>
                <label>Expected service life (months)<input name="serviceLifeMonths" type="number" min="0" max="1200" value="0"></label>
                <button type="submit">Register component</button>
            </form>
        </section>
        <section aria-labelledby="component-list-heading">
            <h3 id="component-list-heading">Component inventory</h3>
            <div id="component-table">${createTable(["Component ID", "Type", "Serial", "Kiosk", "Status", "Warranty", "Details"], "", "Loading components…")}</div>
            <div class="data-page-controls" id="data-load-more"></div>
        </section>`);

    const table = document.getElementById("component-table");
    let cursor = null;
    const appendPage = async (page, replace) => {
        const rows = page.items.map((item) => {
            const editor = canEdit ? `<details><summary>Edit details</summary><form class="data-inline-form" data-edit-component="${escapeHtml(item.id)}">
                <label>Manufacturer<input name="manufacturer" value="${fieldValue(item.manufacturer)}" maxlength="120"></label>
                <label>Model<input name="model" value="${fieldValue(item.model)}" maxlength="120"></label>
                <label>Purchase date<input name="purchaseDate" type="date" value="${fieldValue(item.purchaseDate)}"></label>
                <label>Warranty start<input name="warrantyStart" type="date" value="${fieldValue(item.warrantyStart)}"></label>
                <label>Warranty expiry<input name="warrantyExpiry" type="date" value="${fieldValue(item.warrantyExpiry)}"></label>
                <label>Service life (months)<input name="serviceLifeMonths" type="number" min="0" max="1200" value="${Number(item.serviceLifeMonths || 0)}"></label>
                <button type="submit">Save</button></form></details>` : "—";
            return `<tr><td>${cellText(item.id)}</td><td>${cellText(item.type)}</td><td>${cellText(item.serialNumber)}</td><td>${cellText(item.currentKioskId || "In storage")}</td><td>${cellText(item.status)}</td><td>${cellText(formatDateOnly(item.warrantyExpiry))}</td><td><button class="data-secondary-button" type="button" data-show-history="${escapeHtml(item.id)}">Movement history</button><div id="history-${escapeHtml(item.id)}"></div>${editor}</td></tr>`;
        }).join("");
        if (replace) {
            table.innerHTML = createTable(["Component ID", "Type", "Serial", "Kiosk", "Status", "Warranty", "Details"], rows, "No components found.");
        } else {
            const tbody = table.querySelector("tbody");
            if (tbody.querySelector("[colspan]")) tbody.replaceChildren();
            tbody.insertAdjacentHTML("beforeend", rows);
        }
        cursor = page.cursor;
        installLoadControl(page, async (nextCursor) => appendPage(await loadPage("components", nextCursor), false));
        table.querySelectorAll("form[data-edit-component]").forEach((form) => form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const button = form.querySelector("button");
            button.disabled = true;
            try {
                await updateComponent(form.dataset.editComponent, Object.fromEntries(new FormData(form)), context.user, context.profile);
                setStatus("Component details updated.");
                await searchAndLoad();
            } catch (error) {
                setStatus(error.message || "Could not update this component.", true);
                button.disabled = false;
            }
        }));
        table.querySelectorAll("[data-show-history]").forEach((button) => button.addEventListener("click", async () => {
            const target = document.getElementById(`history-${button.dataset.showHistory}`);
            button.disabled = true;
            try {
                const page = await loadComponentEvents(button.dataset.showHistory);
                const rows = page.items.map((item) =>
                    `<tr><td>${cellText(formatDate(item.createdAt))}</td><td>${cellText(item.eventType)}</td><td>${cellText(item.kioskId)}</td><td>${cellText(item.summary)}</td></tr>`
                ).join("");
                target.innerHTML = createTable(["Date", "Event", "Kiosk", "Summary"], rows, "No events have been recorded for this component.");
                const controls = document.createElement("div");
                controls.className = "data-page-controls";
                target.append(controls);
                const loadMoreHistory = async (cursor) => {
                    const next = await loadComponentEvents(button.dataset.showHistory, cursor);
                    const tbody = target.querySelector("tbody");
                    if (tbody.querySelector("[colspan]")) tbody.replaceChildren();
                    tbody.insertAdjacentHTML("beforeend", next.items.map((item) =>
                        `<tr><td>${cellText(formatDate(item.createdAt))}</td><td>${cellText(item.eventType)}</td><td>${cellText(item.kioskId)}</td><td>${cellText(item.summary)}</td></tr>`
                    ).join(""));
                    pageControls(controls, next, loadMoreHistory);
                };
                pageControls(controls, page, loadMoreHistory);
            } catch (error) {
                target.textContent = error.message || "Could not load component history.";
            } finally {
                button.disabled = false;
            }
        }));
    };
    const searchAndLoad = async (term = "") => {
        setStatus("");
        if (term) {
            const result = await loadComponent(term).then((item) => item || findComponentBySerial(term));
            await appendPage({ items: result ? [result] : [], cursor: null, hasMore: false }, true);
            if (!result) setStatus("No component matched that ID or serial number.");
            return;
        }
        await appendPage(await loadPage("components"), true);
    };
    document.getElementById("component-search-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            await searchAndLoad(document.getElementById("component-search").value.trim());
        } catch (error) {
            setStatus(error.message || "Could not search components.", true);
        }
    });
    document.getElementById("component-search-form").addEventListener("reset", () => {
        window.setTimeout(() => searchAndLoad().catch((error) => setStatus(error.message, true)), 0);
    });
    document.getElementById("component-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        button.disabled = true;
        try {
            const id = await registerComponent(Object.fromEntries(new FormData(form)), context.user, context.profile);
            form.reset();
            setStatus(`Component ${id} registered.`);
            await searchAndLoad();
        } catch (error) {
            setStatus(error.message || "Could not register the component.", true);
        } finally {
            button.disabled = false;
        }
    });
    await searchAndLoad();
}

async function setupKiosks() {
    const canEdit = context.profile.role === "administrator";
    showPage("Kiosks", "Register kiosk locations, review installed components, and maintain kiosk status.", `
        ${canEdit ? `<section aria-labelledby="kiosk-register-heading"><h3 id="kiosk-register-heading">Register a kiosk</h3>
            <form class="data-form" id="kiosk-form">
                <label>Kiosk ID<input name="id" maxlength="128" required></label>
                <label>Location<input name="location" maxlength="200" required></label>
                <label>Installation date<input name="installedDate" type="date"></label>
                <button type="submit">Register kiosk</button>
            </form></section>` : ""}
        <section aria-labelledby="kiosk-search-heading">
            <h3 id="kiosk-search-heading">Find a kiosk</h3>
            <form class="data-toolbar" id="kiosk-search-form"><label for="kiosk-search">Kiosk ID or location</label>
                <input id="kiosk-search" type="search"><button type="submit">Search</button>
                <button type="reset" class="data-secondary-button">Clear</button></form>
        </section>
        <section aria-labelledby="kiosk-list-heading"><h3 id="kiosk-list-heading">Kiosk inventory</h3>
            <div id="kiosk-table">${createTable(["Kiosk", "Location", "Installed", "Status", "Components"], "", "Loading kiosks…")}</div>
            <div class="data-page-controls" id="data-load-more"></div></section>`);
    const table = document.getElementById("kiosk-table");
    const appendPage = async (page, replace) => {
        const rows = page.items.map((item) =>
            `<tr data-kiosk-row="${escapeHtml(item.id)}"><td>${cellText(item.id)}</td><td>${cellText(item.location)}</td><td>${cellText(formatDateOnly(item.installedDate))}</td><td>${cellText(item.status || "active")}</td><td><button class="data-secondary-button" type="button" data-show-installed="${escapeHtml(item.id)}">View components</button>${canEdit ? `<details><summary>Edit</summary><form class="data-inline-form" data-edit-kiosk="${escapeHtml(item.id)}">
                <label>Location<input name="location" value="${fieldValue(item.location)}" maxlength="200" required></label>
                <label>Installed<input name="installedDate" type="date" value="${fieldValue(item.installedDate)}"></label>
                <label>Status<select name="status"><option value="active" ${item.status === "active" ? "selected" : ""}>Active</option><option value="inactive" ${item.status === "inactive" ? "selected" : ""}>Inactive</option></select></label>
                <button type="submit">Save</button></form></details>` : ""}<div id="installed-${escapeHtml(item.id)}"></div></td></tr>`
        ).join("");
        if (replace) table.innerHTML = createTable(["Kiosk", "Location", "Installed", "Status", "Components"], rows, "No kiosks found.");
        else {
            const tbody = table.querySelector("tbody");
            if (tbody.querySelector("[colspan]")) tbody.replaceChildren();
            tbody.insertAdjacentHTML("beforeend", rows);
        }
        installLoadControl(page, async (nextCursor) => appendPage(await loadPage("kiosks", nextCursor), false));
        table.querySelectorAll("[data-show-installed]").forEach((button) => button.addEventListener("click", async () => {
            const target = document.getElementById(`installed-${button.dataset.showInstalled}`);
            button.disabled = true;
            try {
                const assigned = await loadAssignedPage(button.dataset.showInstalled);
                const count = await getAssignedComponentCount(button.dataset.showInstalled);
                target.innerHTML = `<p>${count} component${count === 1 ? "" : "s"} assigned.</p>${assigned.items.length
                    ? `<ul>${assigned.items.map((component) => `<li>${cellText(component.id)} — ${cellText(component.type)} (${cellText(component.status)})</li>`).join("")}</ul>`
                    : "<p>No components are currently assigned to this kiosk.</p>"}`;
                if (assigned.hasMore) {
                    const more = document.createElement("button");
                    more.type = "button";
                    more.className = "data-secondary-button";
                    more.textContent = "Load more assigned components";
                    let assignedCursor = assigned.cursor;
                    more.addEventListener("click", async () => {
                        more.disabled = true;
                        const next = await loadAssignedPage(button.dataset.showInstalled, assignedCursor);
                        target.insertAdjacentHTML("beforeend", `<ul>${next.items.map((component) => `<li>${cellText(component.id)} — ${cellText(component.type)} (${cellText(component.status)})</li>`).join("")}</ul>`);
                        assignedCursor = next.cursor;
                        more.hidden = !next.hasMore;
                        more.disabled = false;
                    });
                    target.append(more);
                }
            } catch (error) {
                setStatus(error.message || "Could not load assigned components.", true);
            } finally {
                button.disabled = false;
            }
        }));
        table.querySelectorAll("form[data-edit-kiosk]").forEach((form) => form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const button = form.querySelector("button");
            button.disabled = true;
            try {
                await updateKiosk(form.dataset.editKiosk, Object.fromEntries(new FormData(form)), context.user, context.profile);
                setStatus("Kiosk details updated.");
                await searchAndLoad();
            } catch (error) {
                setStatus(error.message || "Could not update the kiosk.", true);
                button.disabled = false;
            }
        }));
    };
    const searchAndLoad = async (term = "") => {
        if (!term) return appendPage(await loadPage("kiosks"), true);
        const exact = await loadKiosk(term) || await findKioskByLocation(term);
        if (exact) return appendPage({ items: [exact], cursor: null, hasMore: false }, true);
        const page = await loadPage("kiosks");
        const matches = page.items.filter((item) =>
            `${item.id} ${item.location || ""}`.toLowerCase().includes(term.toLowerCase())
        );
        await appendPage({ items: matches, cursor: null, hasMore: false }, true);
        if (!matches.length) setStatus("No kiosk matched that ID or location.");
    };
    document.getElementById("kiosk-search-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            await searchAndLoad(document.getElementById("kiosk-search").value.trim());
        } catch (error) {
            setStatus(error.message || "Could not search kiosks.", true);
        }
    });
    document.getElementById("kiosk-search-form").addEventListener("reset", () =>
        window.setTimeout(() => searchAndLoad().catch((error) => setStatus(error.message, true)), 0)
    );
    const form = document.getElementById("kiosk-form");
    form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        button.disabled = true;
        try {
            const id = await registerKiosk(Object.fromEntries(new FormData(form)), context.user, context.profile);
            form.reset();
            setStatus(`Kiosk ${id} registered.`);
            await searchAndLoad();
        } catch (error) {
            setStatus(error.message || "Could not register the kiosk.", true);
        } finally {
            button.disabled = false;
        }
    });
    await searchAndLoad();
}

async function setupFaultHistory() {
    showPage("Fault History", "Report equipment issues and review their status. Supervisors and administrators can resolve faults.", `
        <section aria-labelledby="fault-report-heading"><h3 id="fault-report-heading">Report a fault</h3>
            <form class="data-form" id="fault-form">
                <label>Asset type<select name="targetType"><option value="component">Component</option><option value="kiosk">Kiosk</option></select></label>
                <label>Asset ID<input name="targetId" maxlength="128" required></label>
                <label>Severity<select name="severity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
                <label>Fault summary<input name="summary" maxlength="160" required></label>
                <label class="data-wide">Description<textarea name="description" rows="3" maxlength="5000" required></textarea></label>
                <button type="submit">Report fault</button>
            </form></section>
        <section aria-labelledby="fault-list-heading"><h3 id="fault-list-heading">Fault records</h3>
            <div id="fault-table">${createTable(["Date", "Asset", "Fault", "Severity", "Status", "Action"], "", "Loading faults…")}</div>
            <div class="data-page-controls" id="data-load-more"></div></section>`);
    const table = document.getElementById("fault-table");
    const canResolve = ["supervisor", "administrator"].includes(context.profile.role);
    const appendPage = (page, replace) => {
        const rows = page.items.map((fault) =>
            `<tr><td>${cellText(formatDate(fault.createdAt))}</td><td>${cellText(fault.targetType)}: ${cellText(fault.targetId)}</td><td>${cellText(fault.summary)}<details><summary>Details</summary><p>${cellText(fault.description)}</p></details></td><td>${cellText(fault.severity)}</td><td>${cellText(fault.status)}</td><td>${canResolve && fault.status === "open" ? `<button type="button" data-resolve-fault="${escapeHtml(fault.id)}">Resolve</button>` : "—"}</td></tr>`
        ).join("");
        if (replace) table.innerHTML = createTable(["Date", "Asset", "Fault", "Severity", "Status", "Action"], rows, "No faults have been recorded.");
        else {
            const tbody = table.querySelector("tbody");
            if (tbody.querySelector("[colspan]")) tbody.replaceChildren();
            tbody.insertAdjacentHTML("beforeend", rows);
        }
        installLoadControl(page, async (cursor) => appendPage(await loadRecentPage("faults", cursor), false));
        table.querySelectorAll("[data-resolve-fault]").forEach((button) => button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                await resolveFault(button.dataset.resolveFault, context.user, context.profile);
                setStatus("Fault marked as resolved.");
                await renderFirstPage();
            } catch (error) {
                setStatus(error.message || "Could not resolve this fault.", true);
                button.disabled = false;
            }
        }));
    };
    const renderFirstPage = async () => appendPage(await loadRecentPage("faults"), true);
    document.getElementById("fault-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector("button");
        button.disabled = true;
        try {
            await recordFault(Object.fromEntries(new FormData(form)), context.user, context.profile);
            form.reset();
            setStatus("Fault reported and linked to the asset history.");
            await renderFirstPage();
        } catch (error) {
            setStatus(error.message || "Could not report this fault.", true);
        } finally {
            button.disabled = false;
        }
    });
    await renderFirstPage();
}

async function setupAlerts() {
    const canSeeConflicts = ["supervisor", "administrator"].includes(context.profile.role);
    showPage("Alerts", "Warranty, expected service-life, open-fault, and assignment-conflict alerts.", `
        <section><h3>Active alerts</h3>
            <p>Warranty and service-life alerts are calculated from component records. Inventory is checked in pages to avoid downloading all records at once.</p>
            <div id="alert-table">${createTable(["Date", "Asset", "Alert", "Status", "Action"], "", "Loading alerts…")}</div>
            <div class="data-page-controls" id="component-alert-more"></div>
            <div class="data-page-controls" id="fault-alert-more"></div>
            <div class="data-page-controls" id="conflict-alert-more"></div></section>`);
    const table = document.getElementById("alert-table");
    table.addEventListener("click", async (event) => {
        const button = event.target instanceof Element
            ? event.target.closest("[data-resolve-conflict]")
            : null;
        if (!button) return;
        button.disabled = true;
        try {
            await resolveConflict(button.dataset.resolveConflict, context.user, context.profile);
            setStatus("Assignment conflict resolved.");
            await setupAlerts();
        } catch (error) {
            setStatus(error.message || "Could not resolve the conflict.", true);
            button.disabled = false;
        }
    });
    const appendRows = (rows) => {
        const tbody = table.querySelector("tbody");
        if (tbody.querySelector("[colspan]")) tbody.replaceChildren();
        if (rows) tbody.insertAdjacentHTML("beforeend", rows);
    };
    const componentPage = async (page) => {
        const rows = componentAlertRecords(page.items).map((alert) =>
            `<tr><td>${cellText(formatDateOnly(alert.date))}</td><td>${cellText(alert.asset)}</td><td>${cellText(alert.message)}</td><td>${cellText(alert.status)}</td><td>—</td></tr>`
        ).join("");
        appendRows(rows);
        pageControls(document.getElementById("component-alert-more"), page, async (cursor) =>
            componentPage(await loadPage("components", cursor))
        );
    };
    const faultPage = async (page) => {
        const rows = page.items.filter((fault) => fault.status === "open").map((fault) =>
            `<tr><td>${cellText(formatDate(fault.createdAt))}</td><td>${cellText(fault.targetId)}</td><td>${cellText(fault.summary)}</td><td>Open fault</td><td>—</td></tr>`
        ).join("");
        appendRows(rows);
        pageControls(document.getElementById("fault-alert-more"), page, async (cursor) =>
            faultPage(await loadRecentPage("faults", cursor))
        );
    };
    const conflictPage = async (page) => {
        const rows = page.items.filter((conflict) => !conflict.resolved).map((conflict) =>
            `<tr><td>${cellText(formatDate(conflict.createdAt))}</td><td>${cellText(conflict.componentId)}</td><td>Assignment conflict: ${cellText(conflict.reason)}</td><td>Needs review</td><td>${context.profile.role === "administrator" ? `<button type="button" data-resolve-conflict="${escapeHtml(conflict.id)}">Resolve</button>` : "—"}</td></tr>`
        ).join("");
        appendRows(rows);
        pageControls(document.getElementById("conflict-alert-more"), page, async (cursor) =>
            conflictPage(await loadRecentPage("conflicts", cursor))
        );
    };
    const [components, faults, conflicts] = await Promise.all([
        loadPage("components"),
        loadRecentPage("faults"),
        canSeeConflicts ? loadRecentPage("conflicts") : Promise.resolve(null)
    ]);
    await componentPage(components);
    await faultPage(faults);
    if (conflicts) await conflictPage(conflicts);
    if (!table.querySelector("tbody tr:not([colspan])")) {
        table.innerHTML = createTable(["Date", "Asset", "Alert", "Status", "Action"], "", "No active alerts found.");
    }
}

function csvCell(value) {
    const text = value?.toDate ? value.toDate().toISOString() : String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
}

async function loadAllReportRecords(collectionName, recent = false) {
    const records = [];
    let cursor = null;
    let page;
    do {
        page = recent
            ? await loadRecentPage(collectionName, cursor)
            : await loadPage(collectionName, cursor);
        records.push(...page.items);
        cursor = page.cursor;
    } while (page.hasMore);
    return records;
}

function downloadReportCsv(report, records) {
    const lines = [
        report.fields.map((field) => csvCell(field.label)).join(","),
        ...records.map((record) => report.fields.map((field) => csvCell(record[field.key])).join(","))
    ];
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pathfinder-${report.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function setupReports() {
    const reports = [
        {
            key: "movement-history",
            title: "Movement history",
            description: "Component events, newest first.",
            icon: "↔",
            collection: "events",
            recent: true,
            fields: [
                { key: "createdAt", label: "Date" },
                { key: "eventType", label: "Event" },
                { key: "componentId", label: "Component" },
                { key: "sourceKioskId", label: "From kiosk" },
                { key: "destinationKioskId", label: "To kiosk" },
                { key: "summary", label: "Summary" },
                { key: "createdBy", label: "Recorded by" }
            ]
        },
        {
            key: "kiosk-configuration",
            title: "Kiosk configuration",
            description: "Kiosks and their currently installed components.",
            collection: "kiosks",
            fields: [
                { key: "id", label: "Kiosk" },
                { key: "location", label: "Location" },
                { key: "installedDate", label: "Installed date" },
                { key: "status", label: "Status" },
                { key: "installedComponents", label: "Installed components" }
            ]
        },
        {
            key: "warranty-lifecycle",
            title: "Warranty & lifecycle",
            description: "Warranty and service-life dates for registered components.",
            collection: "components",
            filter: (component) => Boolean(component.warrantyExpiry || component.serviceLifeExpiry),
            fields: [
                { key: "id", label: "Component" },
                { key: "type", label: "Type" },
                { key: "serialNumber", label: "Serial number" },
                { key: "currentKioskId", label: "Current kiosk" },
                { key: "warrantyStart", label: "Warranty start" },
                { key: "warrantyExpiry", label: "Warranty expiry" },
                { key: "serviceLifeExpiry", label: "Service-life expiry" },
                { key: "status", label: "Status" }
            ]
        },
        {
            key: "missing-components",
            title: "Missing components",
            description: "Components explicitly marked missing in the register.",
            collection: "components",
            filter: (component) => component.missing === true
                || String(component.status || "").toLowerCase() === "missing",
            fields: [
                { key: "id", label: "Component" },
                { key: "type", label: "Type" },
                { key: "serialNumber", label: "Serial number" },
                { key: "manufacturer", label: "Manufacturer" },
                { key: "model", label: "Model" },
                { key: "currentKioskId", label: "Last kiosk" },
                { key: "status", label: "Status" }
            ]
        },
        {
            key: "fault-report",
            title: "Fault report",
            description: "Reported faults, severity, target, and status.",
            collection: "faults",
            recent: true,
            fields: [
                { key: "createdAt", label: "Date reported" },
                { key: "targetType", label: "Target type" },
                { key: "targetId", label: "Target" },
                { key: "summary", label: "Summary" },
                { key: "severity", label: "Severity" },
                { key: "status", label: "Status" },
                { key: "reportedBy", label: "Reported by" },
                { key: "resolvedAt", label: "Date resolved" }
            ]
        },
        {
            key: "full-inventory",
            title: "Full inventory",
            description: "Component identity, location, status, and warranty.",
            collection: "components",
            fields: [
                { key: "id", label: "Component" },
                { key: "type", label: "Type" },
                { key: "serialNumber", label: "Serial number" },
                { key: "manufacturer", label: "Manufacturer" },
                { key: "model", label: "Model" },
                { key: "currentKioskId", label: "Current kiosk" },
                { key: "status", label: "Status" },
                { key: "warrantyExpiry", label: "Warranty expiry" },
                { key: "createdAt", label: "Date registered" }
            ]
        }
    ];
    const reportIcons = {
        "kiosk-configuration": "▣",
        "warranty-lifecycle": "!",
        "missing-components": "?",
        "fault-report": "⚠",
        "full-inventory": "≡"
    };
    reports.forEach((report) => {
        if (!report.icon) report.icon = reportIcons[report.key];
    });

    showPage("Reports", "Generate and preview reports from current database records.", `
        <div class="data-reports-grid" id="data-reports-grid">
            ${reports.map((report) => `
                <article class="data-report-card">
                    <span class="data-report-icon" aria-hidden="true">${report.icon}</span>
                    <h3>${report.title}</h3>
                    <p>${report.description}</p>
                    <span class="data-report-source">Generated from current database records.</span>
                    <div class="data-report-actions">
                        <button type="button" data-report-export="${report.key}">Export CSV</button>
                        <button type="button" class="data-secondary-button" data-report-preview="${report.key}">Preview</button>
                    </div>
                </article>`).join("")}
        </div>
        <dialog class="data-report-preview" id="data-report-preview" aria-labelledby="data-report-preview-title">
            <div class="data-report-preview-content">
                <header class="data-report-preview-header">
                    <h2 id="data-report-preview-title"></h2>
                    <button type="button" class="data-secondary-button" data-close-report-preview aria-label="Close preview">Close</button>
                </header>
                <p id="data-report-preview-count"></p>
                <div id="data-report-preview-table"></div>
            </div>
        </dialog>`);

    const reportGrid = document.getElementById("data-reports-grid");
    const previewDialog = document.getElementById("data-report-preview");
    previewDialog.querySelector("[data-close-report-preview]")
        .addEventListener("click", () => previewDialog.close());
    previewDialog.addEventListener("click", (event) => {
        if (event.target === previewDialog) previewDialog.close();
    });

    const loadReport = async (report) => {
        if (report.key === "kiosk-configuration") {
            const [kiosks, components] = await Promise.all([
                loadAllReportRecords("kiosks"),
                loadAllReportRecords("components")
            ]);
            const installedByKiosk = new Map();
            components.forEach((component) => {
                if (!component.currentKioskId) return;
                const installed = installedByKiosk.get(component.currentKioskId) || [];
                installed.push(component.id);
                installedByKiosk.set(component.currentKioskId, installed);
            });
            return kiosks.map((kiosk) => ({
                ...kiosk,
                installedComponents: (installedByKiosk.get(kiosk.id) || []).join(", ")
            }));
        }
        const records = await loadAllReportRecords(report.collection, report.recent);
        return report.filter ? records.filter(report.filter) : records;
    };

    reportGrid.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-report-export], [data-report-preview]");
        if (!button) return;
        const reportKey = button.dataset.reportExport || button.dataset.reportPreview;
        const report = reports.find((item) => item.key === reportKey);
        if (!report) {
            setStatus("Could not find the selected report.", true);
            return;
        }

        button.disabled = true;
        const originalLabel = button.textContent;
        button.textContent = button.hasAttribute("data-report-export") ? "Preparing…" : "Loading…";
        try {
            const records = await loadReport(report);
            if (button.hasAttribute("data-report-export")) {
                downloadReportCsv(report, records);
                setStatus(`${report.title} CSV downloaded.`);
            } else {
                const previewLimit = 25;
                const rows = records.slice(0, previewLimit).map((record) =>
                    `<tr>${report.fields.map((field) => `<td>${cellText(
                        field.key === "createdAt" || field.key === "resolvedAt"
                            ? formatDate(record[field.key])
                            : record[field.key]
                    )}</td>`).join("")}</tr>`
                ).join("");
                previewDialog.querySelector("#data-report-preview-title").textContent = report.title;
                previewDialog.querySelector("#data-report-preview-count").textContent =
                    records.length > previewLimit
                        ? `Showing ${previewLimit} of ${records.length} records.`
                        : `${records.length} record${records.length === 1 ? "" : "s"}.`;
                previewDialog.querySelector("#data-report-preview-table").innerHTML = createTable(
                    report.fields.map((field) => field.label),
                    rows,
                    "No records found for this report."
                );
                previewDialog.showModal();
            }
        } catch (error) {
            setStatus(error.message || `Could not load the ${report.title.toLowerCase()} report.`, true);
        } finally {
            button.disabled = false;
            button.textContent = originalLabel;
        }
    });
}

async function setupUsers() {
    if (context.profile.role !== "administrator") {
        showPage("Users", "Account roles are managed by an administrator.", `<section><p>You do not have permission to view or change other users' roles.</p></section>`);
        return;
    }
    showPage("Users", "Review Pathfinder accounts and assign least-privilege roles.", `
        <section class="role-management">
            <p>New accounts receive the technician role by default. Ask staff to sign up normally, then assign their role here. For account safety, an administrator cannot change their own role; another administrator must do that.</p>
            <div id="users-table">${createTable(["Name", "Email", "Current role", "Change role", "Save"], "", "Loading users…")}</div>
            <div class="users-pagination" id="users-pagination" aria-live="polite"></div></section>`);
    const table = document.getElementById("users-table");
    const pagination = document.getElementById("users-pagination");
    const usersQuery = collection(db, "users");
    const pageSize = 10;
    let totalUsers = 0;
    let orderField = "createdAt";
    let pageIndex = 0;
    let lastDocument = null;
    const pageFirstDocuments = [];

    const attachRoleHandlers = () => table.querySelectorAll("[data-save-role]").forEach((button) => button.addEventListener("click", async () => {
        const row = button.closest("tr");
        const select = row.querySelector("[data-user-role]");
        if (!select || select.disabled) return;
        const previousRole = row.dataset.currentRole;
        const nextRole = select.value;
        if (nextRole === "administrator" && previousRole !== "administrator" &&
            !window.confirm(`Promote ${select.getAttribute("aria-label").replace("Role for ", "")} to administrator?`)) {
            return;
        }
        button.disabled = true;
        try {
            const changed = await updateUserRole(button.dataset.saveRole, nextRole, context.profile, context.user.uid);
            row.dataset.currentRole = nextRole;
            row.querySelector('[data-label="Current role"]').textContent = nextRole;
            setStatus(changed ? "User role updated and recorded in the audit log." : "The user already has that role.");
        } catch (error) {
            setStatus(error.message || "Could not update the user role.", true);
        } finally {
            button.disabled = false;
        }
    }));

    const renderPagination = () => {
        pagination.replaceChildren();
        if (!totalUsers) return;
        const pageCount = Math.ceil(totalUsers / pageSize);
        const start = pageIndex * pageSize + 1;
        const end = Math.min((pageIndex + 1) * pageSize, totalUsers);
        const previous = document.createElement("button");
        previous.type = "button";
        previous.className = "users-page-button";
        previous.textContent = "Previous";
        previous.disabled = pageIndex === 0;
        previous.addEventListener("click", () => loadUsersPage(pageIndex - 1));
        const indicator = document.createElement("span");
        indicator.className = "users-page-indicator";
        indicator.textContent = `Page ${pageIndex + 1} of ${pageCount}`;
        const showing = document.createElement("span");
        showing.className = "users-showing";
        showing.textContent = `Showing ${start}-${end} of ${totalUsers} users`;
        const next = document.createElement("button");
        next.type = "button";
        next.className = "users-page-button";
        next.textContent = "Next";
        next.disabled = pageIndex >= pageCount - 1;
        next.addEventListener("click", () => loadUsersPage(pageIndex + 1));
        pagination.append(previous, indicator, showing, next);
    };

    const renderRows = (documents) => {
        const rows = documents.map((snapshot) => {
            const user = { id: snapshot.id, ...snapshot.data() };
            const isCurrentUser = user.id === context.user.uid;
            const validRole = ROLES.includes(user.role);
            const roleOptions = ROLES.map((role) =>
                `<option value="${role}" ${user.role === role ? "selected" : ""}>${role}</option>`
            ).join("");
            const invalidRoleOption = validRole ? "" : `<option value="" selected disabled>Invalid role</option>`;
            return `<tr data-current-role="${escapeHtml(user.role)}">
                <td data-label="Name">${cellText(user.displayName)}</td>
                <td data-label="Email">${cellText(user.email)}</td>
                <td data-label="Current role">${cellText(user.role)}</td>
                <td data-label="Change role"><select aria-label="New role for ${cellText(user.email)}" data-user-role="${escapeHtml(user.id)}" ${isCurrentUser || !validRole ? "disabled title=\"Ask another administrator to change your role.\"" : ""}>${invalidRoleOption}${roleOptions}</select></td>
                <td data-label="Save"><button type="button" data-save-role="${escapeHtml(user.id)}" aria-label="Save role for ${cellText(user.email)}" ${isCurrentUser || !validRole ? "disabled" : ""}>Save role</button></td>
            </tr>`;
        }).join("");
        table.innerHTML = createTable(
            ["Name", "Email", "Current role", "Change role", "Save"],
            rows,
            "No users found"
        );
        attachRoleHandlers();
    };

    // Use createdAt only when every user has it; otherwise order all users by email.
    const loadUsersPage = async (targetPage, isInitialLoad = false) => {
        table.innerHTML = createTable(
            ["Name", "Email", "Current role", "Change role", "Save"],
            "",
            "Loading users…"
        );
        pagination.replaceChildren();
        setStatus("Loading users…");
        try {
            if (isInitialLoad) {
                const totalSnapshot = await getCountFromServer(usersQuery);
                totalUsers = totalSnapshot.data().count;
                if (!totalUsers) {
                    table.innerHTML = createTable(
                        ["Name", "Email", "Current role", "Change role", "Save"],
                        "",
                        "No users found"
                    );
                    setStatus("");
                    return;
                }
                const timestampCount = await getCountFromServer(
                    query(usersQuery, orderBy("createdAt", "desc"))
                );
                orderField = timestampCount.data().count === totalUsers
                    ? "createdAt"
                    : "email";
                const orderedCount = orderField === "email"
                    ? await getCountFromServer(query(usersQuery, orderBy("email")))
                    : timestampCount;
                if (orderedCount.data().count !== totalUsers) {
                    throw new Error("Users are missing both createdAt and email values required for pagination.");
                }
            }

            const ordering = orderBy(orderField, orderField === "createdAt" ? "desc" : "asc");
            let pageQuery = query(usersQuery, ordering, limit(pageSize));
            if (targetPage > pageIndex) {
                pageQuery = query(usersQuery, ordering, startAfter(lastDocument), limit(pageSize));
            } else if (targetPage < pageIndex) {
                pageQuery = query(usersQuery, ordering, startAt(pageFirstDocuments[targetPage]), limit(pageSize));
            }
            const snapshot = await getDocs(pageQuery);
            if (snapshot.empty) {
                table.innerHTML = createTable(
                    ["Name", "Email", "Current role", "Change role", "Save"],
                    "",
                    "No users found"
                );
                setStatus("");
                return;
            }
            pageIndex = targetPage;
            pageFirstDocuments[pageIndex] = snapshot.docs[0];
            lastDocument = snapshot.docs[snapshot.docs.length - 1];
            renderRows(snapshot.docs);
            renderPagination();
            setStatus("");
        } catch (error) {
            setStatus(error.message || "Could not load users.", true);
            table.innerHTML = createTable(
                ["Name", "Email", "Current role", "Change role", "Save"],
                "",
                "Could not load users."
            );
        }
    };

    await loadUsersPage(0, true);
}

async function setupAuditLog() {
    if (!["supervisor", "administrator"].includes(context.profile.role)) {
        showPage("Audit Log", "Review a tamper-resistant record of asset and account changes.", `<section><p>You need a supervisor or administrator role to view the audit log.</p></section>`);
        return;
    }
    showPage("Audit Log", "Audit records are immutable and created in the same transaction as the action they describe.", `
        <section><div id="audit-table">${createTable(["Date", "Action", "Asset / account", "By", "Summary"], "", "Loading audit records…")}</div>
            <div class="data-page-controls" id="data-load-more"></div></section>`);
    const table = document.getElementById("audit-table");
    const appendPage = (page, replace) => {
        const rows = page.items.map((item) =>
            `<tr><td>${cellText(formatDate(item.createdAt))}</td><td>${cellText(item.action)}</td><td>${cellText(item.entityType)}: ${cellText(item.entityId)}</td><td>${cellText(item.performedByEmail || item.performedBy)}</td><td>${cellText(item.summary || item.eventType || item.role)}</td></tr>`
        ).join("");
        if (replace) table.innerHTML = createTable(["Date", "Action", "Asset / account", "By", "Summary"], rows, "No audit records found.");
        else {
            const tbody = table.querySelector("tbody");
            if (tbody.querySelector("[colspan]")) tbody.replaceChildren();
            tbody.insertAdjacentHTML("beforeend", rows);
        }
        installLoadControl(page, async (cursor) => appendPage(await loadRecentPage("auditLogs", cursor), false));
    };
    await appendPage(await loadRecentPage("auditLogs"), true);
}

async function setupRoles() {
    if (context.profile.role !== "administrator") {
        showPage("Roles", "Page access is managed by an administrator.", `<section><p>You do not have permission to manage page access.</p></section>`);
        return;
    }

    const headers = ["Name", "Email", "Role", "Actions"];
    showPage("Roles", "View user details and manage page access. Administrators always have access to every page.", `
        <section class="role-management">
            <p>Open a user’s profile to manage their page access. Users without a saved value keep the default access for their role. You cannot change your own access or remove access from an administrator.</p>
            <div id="roles-table">${createTable(headers, "", "Loading users…")}</div>
            <dialog class="user-profile-dialog" id="user-profile-dialog" aria-labelledby="user-profile-title">
                <div class="user-profile-dialog-content">
                    <header class="user-profile-header">
                        <div class="user-profile-avatar" id="user-profile-avatar" aria-hidden="true"></div>
                        <div><h2 id="user-profile-title"></h2><p id="user-profile-email"></p></div>
                    </header>
                    <dl class="user-profile-facts">
                        <div><dt>Role</dt><dd id="user-profile-role"></dd></div>
                        <div><dt>App activity</dt><dd class="user-profile-account-status" id="user-profile-status">Not tracked</dd></div>
                        <div><dt>Joined</dt><dd id="user-profile-joined"></dd></div>
                        <div><dt>Last signed in</dt><dd id="user-profile-last-sign-in">Not tracked</dd></div>
                    </dl>
                    <section class="user-profile-section">
                        <h3>Page access</h3>
                        <p class="user-profile-permission-help">Select one or more pages, then save your changes.</p>
                        <div class="user-profile-pages" id="user-profile-pages" role="group" aria-label="Pages this user can access"></div>
                        <p class="user-profile-permission-status" id="user-profile-permission-status" role="status" aria-live="polite"></p>
                    </section>
                    <section class="user-profile-section">
                        <h3>Recent account activity</h3>
                        <ul class="user-profile-activity" id="user-profile-activity"><li>Loading activity…</li></ul>
                    </section>
                    <div class="user-profile-footer">
                        <button type="button" class="user-profile-save data-secondary-button" id="user-profile-save" hidden disabled>Save changes</button>
                        <button type="button" class="user-profile-close">Close</button>
                    </div>
                </div>
            </dialog>
        </section>`);
    const table = document.getElementById("roles-table");
    const profileDialog = document.getElementById("user-profile-dialog");
    const profilePages = profileDialog.querySelector("#user-profile-pages");
    const profileSaveButton = profileDialog.querySelector("#user-profile-save");
    const profilePermissionStatus = profileDialog.querySelector("#user-profile-permission-status");
    let activeProfileUser = null;
    let activeProfileCanEdit = false;
    let savedProfilePermissions = {};
    let draftProfilePermissions = {};
    let stopWatchingProfile = () => {};
    const profileStatus = profileDialog.querySelector("#user-profile-status");
    const profileLastSignIn = profileDialog.querySelector("#user-profile-last-sign-in");
    const refreshProfileStatus = (user) => {
        const lastActiveAt = user.lastActiveAt?.toDate?.();
        const age = lastActiveAt ? Date.now() - lastActiveAt.getTime() : Infinity;
        const isActive = age >= 0 && age <= 120_000;
        profileStatus.dataset.state = isActive ? "active" : lastActiveAt ? "inactive" : "unknown";
        profileStatus.textContent = isActive ? "Active" : lastActiveAt ? "Inactive" : "Not tracked";
        profileLastSignIn.textContent = formatDate(user.lastSignInAt);
    };
    profileDialog.querySelector(".user-profile-close").addEventListener("click", () => profileDialog.close());
    profileDialog.addEventListener("close", () => stopWatchingProfile());
    profileDialog.addEventListener("click", (event) => {
        if (event.target === profileDialog) profileDialog.close();
    });
    setStatus("Loading users…");

    try {
        const snapshot = await getDocs(collection(db, "users"));
        const users = snapshot.docs
            .map((document) => ({ id: document.id, ...document.data() }))
            .sort((left, right) =>
                String(left.displayName || left.email || "").localeCompare(
                    String(right.displayName || right.email || "")
                )
            );
        const rows = users.map((user) => {
            const isCurrentUser = user.id === context.user.uid;
            return `<tr>
                <td>${cellText(user.displayName)}</td>
                <td>${cellText(user.email)}</td>
                <td>${cellText(user.role)}</td>
                <td class="role-actions"><button type="button" class="data-secondary-button" data-view-user="${escapeHtml(user.id)}">View</button>
                    ${isCurrentUser ? "<span>This is you</span>" : ""}</td>
            </tr>`;
        }).join("");
        table.innerHTML = createTable(headers, rows, "No users found");

        table.querySelectorAll("[data-view-user]").forEach((button) => {
            button.addEventListener("click", async () => {
                const user = users.find((item) => item.id === button.dataset.viewUser);
                if (!user) {
                    setStatus("Could not find the selected user.", true);
                    return;
                }
                const displayName = user.displayName || user.email || "Pathfinder user";
                profileDialog.querySelector("#user-profile-title").textContent = displayName;
                profileDialog.querySelector("#user-profile-email").textContent = user.email || "No email on file";
                profileDialog.querySelector("#user-profile-avatar").textContent =
                    displayName.trim().charAt(0).toUpperCase() || "?";
                profileDialog.querySelector("#user-profile-role").textContent =
                    user.role ? user.role.replaceAll("_", " ") : "Unknown";
                profileDialog.querySelector("#user-profile-joined").textContent = formatDate(user.createdAt);
                stopWatchingProfile();
                refreshProfileStatus(user);
                const unsubscribe = onSnapshot(doc(db, "users", user.id), (userSnapshot) => {
                    if (!userSnapshot.exists()) {
                        profileStatus.dataset.state = "unknown";
                        profileStatus.textContent = "Unavailable";
                        return;
                    }
                    Object.assign(user, userSnapshot.data());
                    if (activeProfileUser === user) refreshProfileStatus(user);
                }, (error) => {
                    console.error("Could not refresh user activity status.", error);
                    profileStatus.dataset.state = "unknown";
                    profileStatus.textContent = "Could not load";
                });
                const refreshTimer = window.setInterval(() => refreshProfileStatus(user), 15_000);
                stopWatchingProfile = () => {
                    unsubscribe();
                    window.clearInterval(refreshTimer);
                };
                activeProfileUser = user;
                activeProfileCanEdit = ROLES.includes(user.role)
                    && user.id !== context.user.uid
                    && user.role !== "administrator";
                savedProfilePermissions = Object.fromEntries(
                    GRANTABLE_PAGES.map((page) => [page.key, hasPageAccess(user, page.key)])
                );
                draftProfilePermissions = { ...savedProfilePermissions };
                profilePermissionStatus.textContent = "";
                profileSaveButton.hidden = !activeProfileCanEdit;
                profileSaveButton.disabled = true;
                profilePages.replaceChildren(...GRANTABLE_PAGES.map((page) => {
                    const selected = draftProfilePermissions[page.key];
                    const accessButton = document.createElement("button");
                    accessButton.type = "button";
                    accessButton.className = "user-profile-page-option";
                    accessButton.textContent = page.label;
                    accessButton.dataset.pageAccess = page.key;
                    accessButton.setAttribute("aria-pressed", String(selected));
                    accessButton.setAttribute(
                        "aria-label",
                        `${page.label} access: ${selected ? "selected" : "not selected"}`
                    );
                    accessButton.classList.toggle("is-selected", selected);
                    accessButton.disabled = !activeProfileCanEdit;
                    return accessButton;
                }));
                const activity = profileDialog.querySelector("#user-profile-activity");
                activity.replaceChildren(Object.assign(document.createElement("li"), {
                    textContent: "Loading activity…"
                }));
                profileDialog.showModal();

                try {
                    const activitySnapshot = await getDocs(query(
                        collection(db, "auditLogs"),
                        where("entityId", "==", user.id),
                        limit(20)
                    ));
                    const activityRecords = activitySnapshot.docs
                        .map((record) => ({ record, data: record.data() }))
                        .sort((left, right) => {
                            const leftTime = left.data.createdAt?.toMillis?.() || 0;
                            const rightTime = right.data.createdAt?.toMillis?.() || 0;
                            return rightTime - leftTime;
                        })
                        .slice(0, 5);
                    activity.replaceChildren();
                    if (!activityRecords.length) {
                        const empty = document.createElement("li");
                        empty.textContent = "No account activity recorded.";
                        activity.append(empty);
                        return;
                    }
                    activityRecords.forEach(({ data: item }) => {
                        const entry = document.createElement("li");
                        const action = document.createElement("strong");
                        action.textContent = item.summary || item.action || "Account updated";
                        const date = document.createElement("time");
                        date.textContent = formatDate(item.createdAt);
                        entry.append(action, date);
                        activity.append(entry);
                    });
                } catch (error) {
                    activity.replaceChildren();
                    const message = document.createElement("li");
                    message.textContent = error.message || "Could not load account activity.";
                    activity.append(message);
                }
            });
        });

        profilePages.addEventListener("click", (event) => {
            const button = event.target.closest("[data-page-access]");
            if (!button || button.disabled) return;
            const pageKey = button.dataset.pageAccess;
            const selected = !draftProfilePermissions[pageKey];
            draftProfilePermissions[pageKey] = selected;
            button.setAttribute("aria-pressed", String(selected));
            button.setAttribute(
                "aria-label",
                `${GRANTABLE_PAGES.find((page) => page.key === pageKey)?.label} access: ${selected ? "selected" : "not selected"}`
            );
            button.classList.toggle("is-selected", selected);
            profileSaveButton.disabled = !GRANTABLE_PAGES.some(
                (page) => draftProfilePermissions[page.key] !== savedProfilePermissions[page.key]
            );
            profilePermissionStatus.textContent = "";
        });
        profileSaveButton.addEventListener("click", async () => {
            if (!activeProfileUser || !activeProfileCanEdit) return;
            const permissions = { ...draftProfilePermissions };
            profileSaveButton.disabled = true;
            try {
                const changed = await updateUserPermissions(
                    activeProfileUser.id,
                    permissions,
                    context.profile,
                    context.user.uid
                );
                activeProfileUser.permissions = permissions;
                savedProfilePermissions = { ...permissions };
                profilePermissionStatus.textContent = changed
                    ? "Page access updated and recorded in the audit log."
                    : "No page access changes to save.";
            } catch (error) {
                profilePermissionStatus.textContent = error.message || "Could not update page access.";
                setStatus(error.message || "Could not update page access.", true);
                profileSaveButton.disabled = false;
                return;
            }
            setStatus(profilePermissionStatus.textContent);
        });
        setStatus("");
    } catch (error) {
        setStatus(error.message || "Could not load user permissions.", true);
        table.innerHTML = createTable(headers, "", "Could not load users.");
    }
}

async function initializePage() {
    if (started || !main || !context) return;
    started = true;
    try {
        switch (main.dataset.page) {
            case "dashboard": setupDashboard(); break;
            case "components": await setupComponents(); break;
            case "kiosks": await setupKiosks(); break;
            case "fault-history": await setupFaultHistory(); break;
            case "alerts": await setupAlerts(); break;
            case "reports": await setupReports(); break;
            case "users": await setupUsers(); break;
            case "audit-log": await setupAuditLog(); break;
            case "roles": await setupRoles(); break;
            default: started = false; break;
        }
    } catch (error) {
        setStatus(error.message || "Could not load this page.", true);
        started = false;
    }
}

function applyContext(value) {
    context = value;
    initializePage();
}

if (main) {
    if (window.pathfinderProfile) applyContext(window.pathfinderProfile);
    else document.addEventListener("pathfinder:profile-ready", (event) => applyContext(event.detail), { once: true });
    document.addEventListener("pathfinder:offline-sync", (event) => {
        if (event.detail.failed.length) {
            setStatus(`${event.detail.failed.length} offline action(s) could not be synced. Review the error details and retry when connected.`, true);
        } else if (event.detail.offline && event.detail.pendingCount) {
            setStatus(`${event.detail.pendingCount} offline action(s) are waiting on this device.`);
        } else if (event.detail.pendingCount === 0) {
            setStatus("All saved offline actions have synced.");
        }
    });
    document.addEventListener("pathfinder:offline-queue", (event) => {
        if (event.detail.pendingCount) {
            setStatus(`${event.detail.pendingCount} action(s) are saved on this device and waiting to sync.`);
        }
    });
    document.addEventListener("pathfinder:profile-error", (event) => {
        showProfileError(event.detail?.error);
    });
    document.addEventListener("pathfinder:auth-error", (event) => {
        showAuthError(event.detail?.error);
    });
    document.addEventListener("pathfinder:offline-sync-error", () => {
        setStatus("Your account profile is verified, but pending offline actions could not be checked.", true);
    });
    if (window.pathfinderProfileError) showProfileError(window.pathfinderProfileError);
    else if (window.pathfinderAuthError) showAuthError(window.pathfinderAuthError);
}
