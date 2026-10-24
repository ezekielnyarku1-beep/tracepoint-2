export const APP_PAGES = [
    { key: "dashboard", label: "Dashboard", fileName: "index.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "kiosks", label: "Kiosks", fileName: "kiosks.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "components", label: "Components", fileName: "components.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "log-event", label: "Log an Event", fileName: "log-event.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "fault-history", label: "Fault History", fileName: "fault-history.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "alerts", label: "Alerts", fileName: "alerts.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "reports", label: "Reports", fileName: "reports.html", defaultRoles: ["technician", "supervisor", "administrator"], grantable: true },
    { key: "users", label: "Users", fileName: "users.html", defaultRoles: ["administrator"], grantable: true },
    { key: "audit-log", label: "Audit Log", fileName: "audit-log.html", defaultRoles: ["supervisor", "administrator"], grantable: true },
    { key: "roles", label: "Roles", fileName: "roles.html", defaultRoles: ["administrator"], adminOnly: true },
    { key: "account", label: "My account", fileName: "account.html", defaultRoles: ["technician", "supervisor", "administrator"], alwaysAllowed: true }
];

export const GRANTABLE_PAGES = APP_PAGES.filter((page) => page.grantable);

export function roleDefaultPermissions(role) {
    return Object.fromEntries(GRANTABLE_PAGES.map((page) => [
        page.key,
        page.defaultRoles.includes(role)
    ]));
}

export function hasPageAccess(profile, pageKey) {
    const page = APP_PAGES.find((entry) => entry.key === pageKey);
    if (!page || !profile) return false;
    if (profile.role === "administrator") return true;
    if (page.adminOnly) return false;
    if (page.alwaysAllowed) return true;

    const permission = profile.permissions?.[page.key];
    return typeof permission === "boolean"
        ? permission
        : page.defaultRoles.includes(profile.role);
}
