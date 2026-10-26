import {
    collection,
    documentId,
    doc,
    getCountFromServer,
    getDoc,
    getDocFromCache,
    getDocs,
    limit,
    orderBy,
    query,
    runTransaction,
    serverTimestamp,
    startAfter,
    where
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { db } from "./firebase-client.js";
import { GRANTABLE_PAGES, roleDefaultPermissions } from "./page-config.js";

export const PAGE_SIZE = 50;
export const ROLES = ["technician", "supervisor", "administrator"];

export function normalizedPermissions(permissions) {
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
        throw new Error("The permissions value must be a page access map.");
    }
    const keys = Object.keys(permissions);
    if (
        keys.length !== GRANTABLE_PAGES.length ||
        GRANTABLE_PAGES.some((page) => typeof permissions[page.key] !== "boolean") ||
        keys.some((key) => !GRANTABLE_PAGES.some((page) => page.key === key))
    ) {
        throw new Error("Choose an on/off value for every managed page.");
    }
    return Object.fromEntries(GRANTABLE_PAGES.map((page) => [page.key, permissions[page.key]]));
}

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

export function formatDate(value) {
    const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime())
        ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
        : "—";
}

export function formatDateOnly(value) {
    if (!value) return "—";
    const date = value?.toDate ? value.toDate() : new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
        ? "—"
        : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function serializeDocument(snapshot) {
    return { id: snapshot.id, ...snapshot.data() };
}

function verifiedUserProfile(snapshot) {
    const profile = serializeDocument(snapshot);
    if (!ROLES.includes(profile.role)) {
        throw new Error("Your account profile is missing a valid role. Ask an administrator to review it.");
    }
    return profile;
}

export async function getCachedUserProfile(user) {
    try {
        return verifiedUserProfile(await getDocFromCache(doc(db, "users", user.uid)));
    } catch (error) {
        if (["unavailable", "failed-precondition", "unimplemented"].includes(error?.code)) {
            return null;
        }
        throw error;
    }
}

export async function ensureUserProfile(user) {
    const userRef = doc(db, "users", user.uid);
    const existingProfile = await getDoc(userRef);
    if (existingProfile.exists()) return verifiedUserProfile(existingProfile);
    if (!navigator.onLine) {
        throw new Error("Your account profile is not available offline yet. Reconnect once to finish profile setup.");
    }
    return runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(userRef);
        if (!snapshot.exists()) {
            const profile = {
                email: user.email || "",
                displayName: user.displayName || "",
                role: "technician",
                permissions: roleDefaultPermissions("technician"),
                createdAt: serverTimestamp()
            };
            transaction.set(userRef, profile);
            return { id: user.uid, ...profile, role: "technician" };
        }
        return verifiedUserProfile(snapshot);
    });
}

export async function loadPage(collectionName, cursor = null, pageSize = PAGE_SIZE) {
    const constraints = [orderBy(documentId()), limit(pageSize)];
    if (cursor) constraints.splice(1, 0, startAfter(cursor));
    const snapshot = await getDocs(query(collection(db, collectionName), ...constraints));
    return {
        items: snapshot.docs.map(serializeDocument),
        cursor: snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null,
        hasMore: snapshot.docs.length === pageSize
    };
}

export async function loadRecent(collectionName, pageSize = 20) {
    const snapshot = await getDocs(query(
        collection(db, collectionName),
        orderBy("createdAt", "desc"),
        limit(pageSize)
    ));
    return snapshot.docs.map(serializeDocument);
}

export async function loadRecentPage(collectionName, cursor = null, pageSize = PAGE_SIZE) {
    const constraints = [orderBy("createdAt", "desc"), orderBy(documentId(), "desc"), limit(pageSize)];
    if (cursor) constraints.splice(2, 0, startAfter(cursor));
    const snapshot = await getDocs(query(collection(db, collectionName), ...constraints));
    return {
        items: snapshot.docs.map(serializeDocument),
        cursor: snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null,
        hasMore: snapshot.docs.length === pageSize
    };
}

export async function loadComponentEvents(componentId, cursor = null, pageSize = 20) {
    const constraints = [
        where("componentId", "==", componentId),
        orderBy("createdAt", "desc"),
        orderBy(documentId(), "desc"),
        limit(pageSize)
    ];
    if (cursor) constraints.splice(3, 0, startAfter(cursor));
    const snapshot = await getDocs(query(collection(db, "events"), ...constraints));
    return {
        items: snapshot.docs.map(serializeDocument),
        cursor: snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null,
        hasMore: snapshot.docs.length === pageSize
    };
}

export async function loadComponent(componentId) {
    const snapshot = await getDoc(doc(db, "components", componentId));
    return snapshot.exists() ? serializeDocument(snapshot) : null;
}

export async function loadComponentBySerialNumber(serialNumber) {
    const normalizedSerialNumber = String(serialNumber || "").trim();
    if (!normalizedSerialNumber) return null;

    const snapshot = await getDocs(query(
        collection(db, "components"),
        where("serialNumber", "==", normalizedSerialNumber),
        limit(2)
    ));
    if (snapshot.docs.length > 1) {
        throw new Error("Multiple components have this serial number.");
    }
    return snapshot.docs.length ? serializeDocument(snapshot.docs[0]) : null;
}

function requireRole(profile, allowedRoles) {
    if (!profile || !allowedRoles.includes(profile.role)) {
        throw new Error("Your account does not have permission to perform this action.");
    }
}

function cleanText(value, field, maxLength, required = false) {
    const text = String(value || "").trim();
    if (required && !text) throw new Error(`${field} is required.`);
    if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer.`);
    return text;
}

function cleanDocumentId(value, field) {
    const id = cleanText(value, field, 128, true);
    if (id.includes("/")) throw new Error(`${field} cannot contain a slash.`);
    return id;
}

function validateDate(value, field) {
    if (!value) return;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`${field} must be a valid date.`);
    }
}

function serviceLifeExpiry(purchaseDate, months) {
    if (!purchaseDate || !months) return "";
    const [year, month, day] = purchaseDate.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, 1));
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return date.toISOString().slice(0, 10);
}

function documentRef(name, id) {
    return id ? doc(db, name, id) : doc(collection(db, name));
}

const offlineQueueKey = "pathfinder-offline-actions";

function readOfflineQueue() {
    const value = localStorage.getItem(offlineQueueKey);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("The offline action queue is invalid. Export or clear the pending actions before continuing.");
    return parsed;
}

function saveOfflineQueue(queue) {
    localStorage.setItem(offlineQueueKey, JSON.stringify(queue));
    window.dispatchEvent(new CustomEvent("pathfinder:offline-queue", {
        detail: { pendingCount: queue.length }
    }));
}

function queueOfflineAction(type, payload, user, profile, ids = {}) {
    const queue = readOfflineQueue();
    const id = () => crypto.randomUUID();
    queue.push({
        type,
        payload,
        uid: user.uid,
        email: user.email || "",
        profileRole: profile.role,
        createdAt: new Date().toISOString(),
        eventId: ids.eventId || id(),
        faultId: ids.faultId || id()
    });
    saveOfflineQueue(queue);
    return { pending: true };
}

async function writeConflict({ componentId, sourceKioskId, destinationKioskId, user, error }) {
    const conflictRef = documentRef("conflicts");
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        transaction.set(conflictRef, {
            componentId,
            sourceKioskId: sourceKioskId || "",
            destinationKioskId: destinationKioskId || "",
            attemptedBy: user.uid,
            attemptedByEmail: user.email || "",
            reason: error.message,
            createdAt: serverTimestamp(),
            resolved: false,
            lastAuditId: auditRef.id
        });
        transaction.set(auditRef, {
            action: "assignment_conflict",
            entityType: "component",
            entityId: componentId,
            conflictId: conflictRef.id,
            summary: error.message,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
}

export async function recordMovement({
    componentId,
    eventType,
    sourceKioskId = "",
    destinationKioskId = "",
    summary,
    notes = "",
    user,
    profile,
    eventId,
    queueOffline = true
}) {
    requireRole(profile, ROLES);
    const normalizedId = cleanDocumentId(componentId, "Component ID");
    const normalizedSummary = cleanText(summary, "Reason / summary", 160, true);
    const normalizedNotes = cleanText(notes, "Notes", 5000);
    const validTypes = ["move", "install", "removal", "decommission", "maintenance"];
    if (!validTypes.includes(eventType)) throw new Error("Choose a valid component event type.");

    const sourceId = cleanText(sourceKioskId, "Source kiosk", 128);
    const destinationId = cleanText(destinationKioskId, "Destination kiosk", 128);
    if (eventType === "move" && (!sourceId || !destinationId || sourceId === destinationId)) {
        throw new Error("A move needs different source and destination kiosks.");
    }
    if (eventType === "install" && !destinationId) throw new Error("Choose the destination kiosk.");
    if (eventType === "removal" && !sourceId) throw new Error("Choose the kiosk to remove the component from.");

    if (!navigator.onLine && queueOffline) {
        return queueOfflineAction("movement", {
            componentId: normalizedId,
            eventType,
            sourceKioskId: sourceId,
            destinationKioskId: destinationId,
            summary: normalizedSummary,
            notes: normalizedNotes
        }, user, profile, { eventId });
    }

    const componentRef = doc(db, "components", normalizedId);
    const eventRef = documentRef("events", eventId);
    const auditRef = documentRef("auditLogs");
    const changesAssignment = ["move", "install", "removal", "decommission"].includes(eventType);
    const nextKioskId = eventType === "move" || eventType === "install"
        ? destinationId
        : eventType === "removal" || eventType === "decommission"
            ? ""
            : null;

    try {
        await runTransaction(db, async (transaction) => {
            const existingEvent = await transaction.get(eventRef);
            if (existingEvent.exists()) {
                const componentSnapshot = await transaction.get(componentRef);
                if (componentSnapshot.exists() && componentSnapshot.data().lastEventId === eventRef.id) return;
                throw new Error("This event ID is already in use by a different component change.");
            }
            const componentSnapshot = await transaction.get(componentRef);
            if (!componentSnapshot.exists()) throw new Error("No matching component was found.");
            const component = componentSnapshot.data();
            const currentKioskId = component.currentKioskId || "";

            if (component.status === "decommissioned" &&
                ["move", "install", "removal", "decommission"].includes(eventType)) {
                throw new Error("A decommissioned component cannot be assigned or decommissioned again.");
            }
            if (eventType === "move" && currentKioskId !== sourceId) {
                throw new Error(`This component is currently assigned to ${currentKioskId || "storage"}, not ${sourceId}.`);
            }
            if (eventType === "move" && currentKioskId === destinationId) {
                throw new Error("This component is already assigned to the destination kiosk.");
            }
            if (eventType === "install" && currentKioskId) {
                throw new Error(`This component is already assigned to ${currentKioskId}. Remove or move it before installing it elsewhere.`);
            }
            if (eventType === "removal" && currentKioskId !== sourceId) {
                throw new Error(`This component is not currently assigned to ${sourceId}.`);
            }
            if (eventType === "decommission" && component.status === "decommissioned") {
                throw new Error("This component is already decommissioned.");
            }

            const kioskIds = [...new Set([sourceId, destinationId].filter(Boolean))];
            const kioskSnapshots = await Promise.all(kioskIds.map((id) =>
                transaction.get(doc(db, "kiosks", id))
            ));
            for (const kioskSnapshot of kioskSnapshots) {
                if (!kioskSnapshot.exists()) throw new Error(`Kiosk ${kioskSnapshot.id} was not found.`);
                if (kioskSnapshot.data().status && kioskSnapshot.data().status !== "active") {
                    throw new Error(`Kiosk ${kioskSnapshot.id} is not active.`);
                }
            }

            const kioskId = destinationId || sourceId || currentKioskId;
            if (!kioskId && !["maintenance", "decommission"].includes(eventType)) {
                throw new Error("Choose a kiosk for this event.");
            }
            const event = {
                auditId: auditRef.id,
                eventType,
                componentId: normalizedId,
                kioskId,
                sourceKioskId: sourceId,
                destinationKioskId: destinationId,
                summary: normalizedSummary,
                notes: normalizedNotes,
                createdBy: user.uid,
                createdByEmail: user.email || "",
                createdAt: serverTimestamp()
            };
            transaction.set(eventRef, event);
            transaction.set(auditRef, {
                action: "component_event",
                entityType: "component",
                entityId: normalizedId,
                eventId: eventRef.id,
                eventType,
                summary: normalizedSummary,
                performedBy: user.uid,
                performedByEmail: user.email || "",
                createdAt: serverTimestamp()
            });

            if (changesAssignment) {
                transaction.update(componentRef, {
                    currentKioskId: nextKioskId,
                    status: eventType === "decommission"
                        ? "decommissioned"
                        : nextKioskId
                            ? "installed"
                            : "in_storage",
                    lastEventId: eventRef.id,
                    lastAuditId: auditRef.id,
                    updatedAt: serverTimestamp()
                });
            }
        });
        return eventRef.id;
    } catch (error) {
        if (!navigator.onLine && queueOffline) {
            return queueOfflineAction("movement", {
                componentId: normalizedId,
                eventType,
                sourceKioskId: sourceId,
                destinationKioskId: destinationId,
                summary: normalizedSummary,
                notes: normalizedNotes
            }, user, profile, { eventId: eventRef.id });
        }
        if (["move", "install"].includes(eventType) &&
            /already assigned|currently assigned|not active|not found/i.test(error.message)) {
            try {
                await writeConflict({
                    componentId: normalizedId,
                    sourceKioskId: sourceId,
                    destinationKioskId: destinationId,
                    user,
                    error
                });
            } catch (conflictError) {
                console.error("Could not record the assignment conflict.", conflictError);
            }
        }
        throw error;
    }
}

export async function registerComponent(values, user, profile) {
    requireRole(profile, ROLES);
    const id = cleanDocumentId(values.id, "Component ID");
    const type = cleanText(values.type, "Component type", 80, true);
    const serialNumber = cleanDocumentId(values.serialNumber || id, "Serial number");
    const manufacturer = cleanText(values.manufacturer, "Manufacturer", 120);
    const model = cleanText(values.model, "Model", 120);
    const purchaseDate = cleanText(values.purchaseDate, "Purchase date", 10);
    const warrantyStart = cleanText(values.warrantyStart, "Warranty start date", 10);
    const warrantyExpiry = cleanText(values.warrantyExpiry, "Warranty expiry date", 10);
    validateDate(purchaseDate, "Purchase date");
    validateDate(warrantyStart, "Warranty start date");
    validateDate(warrantyExpiry, "Warranty expiry");
    const serviceLifeMonths = Number(values.serviceLifeMonths || 0);
    if (!Number.isInteger(serviceLifeMonths) || serviceLifeMonths < 0 || serviceLifeMonths > 1200) {
        throw new Error("Expected service life must be between 0 and 1200 months.");
    }
    if (warrantyStart && warrantyExpiry && warrantyExpiry < warrantyStart) {
        throw new Error("Warranty expiry must not be earlier than the warranty start date.");
    }

    const componentRef = doc(db, "components", id);
    const serialRef = doc(db, "componentSerials", serialNumber);
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        const [existing, serialReservation] = await Promise.all([
            transaction.get(componentRef),
            transaction.get(serialRef)
        ]);
        if (existing.exists()) throw new Error("A component with this ID is already registered.");
        if (serialReservation.exists()) throw new Error("A component with this serial number is already registered.");
        const serialMatches = await transaction.get(query(
            collection(db, "components"),
            where("serialNumber", "==", serialNumber),
            limit(1)
        ));
        if (!serialMatches.empty) throw new Error("A component with this serial number is already registered.");
        transaction.set(serialRef, {
            componentId: id,
            serialNumber,
            createdBy: user.uid,
            createdAt: serverTimestamp()
        });
        transaction.set(componentRef, {
            type,
            serialNumber,
            manufacturer,
            model,
            purchaseDate,
            warrantyStart,
            warrantyExpiry,
            serviceLifeMonths,
            serviceLifeExpiry: serviceLifeExpiry(purchaseDate, serviceLifeMonths),
            currentKioskId: "",
            status: "in_storage",
            createdBy: user.uid,
            createdByEmail: user.email || "",
            createdAt: serverTimestamp(),
            lastEventId: "",
            lastAuditId: auditRef.id
        });
        transaction.set(auditRef, {
            action: "component_registered",
            entityType: "component",
            entityId: id,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
    return id;
}

export async function registerKiosk(values, user, profile) {
    requireRole(profile, ["administrator"]);
    const id = cleanDocumentId(values.id, "Kiosk ID");
    const location = cleanText(values.location, "Location", 200, true);
    const installedDate = cleanText(values.installedDate, "Installation date", 10);
    validateDate(installedDate, "Installation date");
    const kioskRef = doc(db, "kiosks", id);
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(kioskRef);
        if (existing.exists()) throw new Error("A kiosk with this ID is already registered.");
        transaction.set(kioskRef, {
            location,
            installedDate,
            status: "active",
            lastAuditId: auditRef.id,
            createdBy: user.uid,
            createdByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
        transaction.set(auditRef, {
            action: "kiosk_registered",
            entityType: "kiosk",
            entityId: id,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
    return id;
}

export async function recordFault(values, user, profile, ids = {}, queueOffline = true) {
    requireRole(profile, ROLES);
    if (!["component", "kiosk"].includes(values.targetType)) {
        throw new Error("Choose a valid fault target type.");
    }
    const targetType = values.targetType;
    const targetId = cleanDocumentId(values.targetId, "Asset ID");
    const summary = cleanText(values.summary, "Fault summary", 160, true);
    const description = cleanText(values.description, "Description", 5000, true);
    const severity = values.severity || "medium";
    if (!["low", "medium", "high", "critical"].includes(severity)) {
        throw new Error("Choose a valid fault severity.");
    }
    if (!navigator.onLine && queueOffline) {
        return queueOfflineAction("fault", {
            targetType,
            targetId,
            summary,
            description,
            severity
        }, user, profile, ids);
    }
    const targetRef = doc(db, targetType === "kiosk" ? "kiosks" : "components", targetId);
    const faultRef = documentRef("faults", ids.faultId);
    const eventRef = documentRef("events", ids.eventId);
    const auditRef = documentRef("auditLogs");

    try {
        await runTransaction(db, async (transaction) => {
            const [existingFault, existingEvent] = await Promise.all([
                transaction.get(faultRef),
                transaction.get(eventRef)
            ]);
            if (existingFault.exists() && existingEvent.exists()) return;
            if (existingFault.exists() || existingEvent.exists()) {
                throw new Error("The fault could not be safely retried because part of its record already exists.");
            }
            const target = await transaction.get(targetRef);
            if (!target.exists()) throw new Error(`No matching ${targetType} was found.`);
            const data = target.data();
            const kioskId = targetType === "kiosk" ? targetId : data.currentKioskId || "";
            if (kioskId && targetType === "component") {
                const kiosk = await transaction.get(doc(db, "kiosks", kioskId));
                if (!kiosk.exists()) throw new Error(`The assigned kiosk ${kioskId} was not found.`);
            }
            transaction.set(faultRef, {
                targetType,
                targetId,
                componentId: targetType === "component" ? targetId : "",
                kioskId,
                summary,
                description,
                severity,
                status: "open",
                reportedBy: user.uid,
                reportedByEmail: user.email || "",
                createdAt: serverTimestamp(),
                lastEventId: eventRef.id,
                lastAuditId: auditRef.id
            });
            transaction.set(eventRef, {
                auditId: auditRef.id,
                eventType: "fault",
                faultId: faultRef.id,
                componentId: targetType === "component" ? targetId : "",
                kioskId,
                sourceKioskId: kioskId,
                destinationKioskId: "",
                summary,
                notes: description,
                createdBy: user.uid,
                createdByEmail: user.email || "",
                createdAt: serverTimestamp()
            });
            transaction.set(auditRef, {
                action: "fault_reported",
                entityType: targetType,
                entityId: targetId,
                eventId: eventRef.id,
                faultId: faultRef.id,
                summary,
                performedBy: user.uid,
                performedByEmail: user.email || "",
                createdAt: serverTimestamp()
            });
        });
    } catch (error) {
        if (!navigator.onLine && queueOffline) {
            return queueOfflineAction("fault", {
                targetType,
                targetId,
                summary,
                description,
                severity
            }, user, profile, { eventId: eventRef.id, faultId: faultRef.id });
        }
        throw error;
    }
    return faultRef.id;
}

export async function updateUserRole(uid, role, profile, currentUserId) {
    requireRole(profile, ["administrator"]);
    if (!ROLES.includes(role)) throw new Error("Choose a valid user role.");
    if (uid === currentUserId) throw new Error("Ask another administrator to change your role.");
    const userRef = doc(db, "users", uid);
    const auditRef = documentRef("auditLogs");
    const changed = await runTransaction(db, async (transaction) => {
        const userSnapshot = await transaction.get(userRef);
        if (!userSnapshot.exists()) throw new Error("The selected user profile was not found.");
        const oldRole = userSnapshot.data().role;
        if (!ROLES.includes(oldRole)) {
            throw new Error("The selected user profile has an invalid role and cannot be changed.");
        }
        if (oldRole === role) return false;

        transaction.update(userRef, {
            role,
            updatedAt: serverTimestamp(),
            lastAuditId: auditRef.id
        });
        transaction.set(auditRef, {
            action: "user_role_changed",
            entityType: "user",
            entityId: uid,
            role,
            oldRole,
            newRole: role,
            summary: `Role changed from ${oldRole} to ${role}.`,
            performedBy: currentUserId,
            performedByEmail: profile.email || "",
            createdAt: serverTimestamp()
        });
        return true;
    });
    return changed;
}

export async function updateUserPermissions(uid, permissions, profile, currentUserId) {
    requireRole(profile, ["administrator"]);
    if (uid === currentUserId) throw new Error("You cannot change your own page access.");
    const nextPermissions = normalizedPermissions(permissions);
    const userRef = doc(db, "users", uid);
    const changed = await runTransaction(db, async (transaction) => {
        const userSnapshot = await transaction.get(userRef);
        if (!userSnapshot.exists()) throw new Error("The selected user profile was not found.");
        const userData = userSnapshot.data();
        if (!ROLES.includes(userData.role)) {
            throw new Error("The selected user profile has an invalid role and cannot be changed.");
        }
        if (userData.role === "administrator") {
            throw new Error("Administrator access is always enabled and cannot be changed here.");
        }

        const previousPermissions = roleDefaultPermissions(userData.role);
        for (const page of GRANTABLE_PAGES) {
            if (typeof userData.permissions?.[page.key] === "boolean") {
                previousPermissions[page.key] = userData.permissions[page.key];
            }
        }
        const changedPages = GRANTABLE_PAGES.filter(
            (page) => previousPermissions[page.key] !== nextPermissions[page.key]
        );
        if (!changedPages.length) return false;

        const auditRefs = changedPages.map(() => documentRef("auditLogs"));
        transaction.update(userRef, {
            permissions: nextPermissions,
            updatedAt: serverTimestamp(),
            lastAuditId: auditRefs[auditRefs.length - 1].id
        });
        changedPages.forEach((page, index) => {
            const oldValue = previousPermissions[page.key];
            const newValue = nextPermissions[page.key];
            transaction.set(auditRefs[index], {
                action: "user_permission_changed",
                entityType: "user",
                entityId: uid,
                pageKey: page.key,
                oldValue,
                newValue,
                summary: `${page.label} access changed from ${oldValue ? "on" : "off"} to ${newValue ? "on" : "off"}.`,
                performedBy: currentUserId,
                performedByEmail: profile.email || "",
                createdAt: serverTimestamp()
            });
        });
        return true;
    });
    return changed;
}

export async function getDocumentCount(collectionName) {
    const snapshot = await getCountFromServer(collection(db, collectionName));
    return snapshot.data().count;
}

export async function findComponentBySerial(serial) {
    const snapshot = await getDocs(query(
        collection(db, "components"),
        where("serialNumber", "==", serial),
        limit(1)
    ));
    return snapshot.empty ? null : serializeDocument(snapshot.docs[0]);
}

export async function loadKiosk(kioskId) {
    const snapshot = await getDoc(doc(db, "kiosks", kioskId));
    return snapshot.exists() ? serializeDocument(snapshot) : null;
}

export async function findKioskByLocation(location) {
    const snapshot = await getDocs(query(
        collection(db, "kiosks"),
        where("location", "==", location),
        limit(1)
    ));
    return snapshot.empty ? null : serializeDocument(snapshot.docs[0]);
}

export async function loadAssignedPage(kioskId, cursor = null, pageSize = PAGE_SIZE) {
    const constraints = [
        where("currentKioskId", "==", kioskId),
        orderBy(documentId()),
        limit(pageSize)
    ];
    if (cursor) constraints.splice(2, 0, startAfter(cursor));
    const snapshot = await getDocs(query(collection(db, "components"), ...constraints));
    return {
        items: snapshot.docs.map(serializeDocument),
        cursor: snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null,
        hasMore: snapshot.docs.length === pageSize
    };
}

export async function getAssignedComponentCount(kioskId) {
    const count = await getCountFromServer(query(
        collection(db, "components"),
        where("currentKioskId", "==", kioskId)
    ));
    return count.data().count;
}

export async function getDocumentCountWhere(collectionName, field, operator, value) {
    const count = await getCountFromServer(query(
        collection(db, collectionName),
        where(field, operator, value)
    ));
    return count.data().count;
}

export async function getAlertCountSummary(profile) {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [openFaults, openConflicts, expiredWarranties, upcomingWarranties, serviceLifeDue] = await Promise.all([
        getDocumentCountWhere("faults", "status", "==", "open"),
        ["supervisor", "administrator"].includes(profile?.role)
            ? getDocumentCountWhere("conflicts", "resolved", "==", false)
            : Promise.resolve(0),
        getCountFromServer(query(
            collection(db, "components"),
            where("warrantyExpiry", ">=", "0001-01-01"),
            where("warrantyExpiry", "<=", today)
        )),
        getCountFromServer(query(
            collection(db, "components"),
            where("warrantyExpiry", ">", today),
            where("warrantyExpiry", "<=", soon)
        )),
        getCountFromServer(query(
            collection(db, "components"),
            where("serviceLifeExpiry", ">", "0001-01-01"),
            where("serviceLifeExpiry", "<=", soon)
        ))
    ]);
    return openFaults + openConflicts +
        expiredWarranties.data().count + upcomingWarranties.data().count +
        serviceLifeDue.data().count;
}

export async function updateKiosk(kioskId, values, user, profile) {
    requireRole(profile, ["administrator"]);
    const location = cleanText(values.location, "Location", 200, true);
    const installedDate = cleanText(values.installedDate, "Installation date", 10);
    validateDate(installedDate, "Installation date");
    const status = ["active", "inactive"].includes(values.status) ? values.status : "";
    if (!status) throw new Error("Choose a valid kiosk status.");
    const kioskRef = doc(db, "kiosks", kioskId);
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        const kiosk = await transaction.get(kioskRef);
        if (!kiosk.exists()) throw new Error("The selected kiosk was not found.");
        if (status === "inactive" && kiosk.data().status !== "inactive") {
            const assigned = await transaction.get(query(
                collection(db, "components"),
                where("currentKioskId", "==", kioskId),
                limit(1)
            ));
            if (!assigned.empty) {
                throw new Error("Move or remove the kiosk's assigned components before deactivating it.");
            }
        }
        transaction.update(kioskRef, {
            location,
            installedDate,
            status,
            updatedAt: serverTimestamp(),
            lastAuditId: auditRef.id
        });
        transaction.set(auditRef, {
            action: "kiosk_updated",
            entityType: "kiosk",
            entityId: kioskId,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
}

export async function updateComponent(componentId, values, user, profile) {
    requireRole(profile, ["administrator"]);
    const manufacturer = cleanText(values.manufacturer, "Manufacturer", 120);
    const model = cleanText(values.model, "Model", 120);
    const purchaseDate = cleanText(values.purchaseDate, "Purchase date", 10);
    const warrantyStart = cleanText(values.warrantyStart, "Warranty start date", 10);
    const warrantyExpiry = cleanText(values.warrantyExpiry, "Warranty expiry date", 10);
    validateDate(purchaseDate, "Purchase date");
    validateDate(warrantyStart, "Warranty start date");
    validateDate(warrantyExpiry, "Warranty expiry");
    const serviceLifeMonths = Number(values.serviceLifeMonths || 0);
    if (!Number.isInteger(serviceLifeMonths) || serviceLifeMonths < 0 || serviceLifeMonths > 1200) {
        throw new Error("Expected service life must be between 0 and 1200 months.");
    }
    if (warrantyStart && warrantyExpiry && warrantyExpiry < warrantyStart) {
        throw new Error("Warranty expiry must not be earlier than the warranty start date.");
    }
    const componentRef = doc(db, "components", componentId);
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        const component = await transaction.get(componentRef);
        if (!component.exists()) throw new Error("The selected component was not found.");
        transaction.update(componentRef, {
            manufacturer,
            model,
            purchaseDate,
            warrantyStart,
            warrantyExpiry,
            serviceLifeMonths,
            serviceLifeExpiry: serviceLifeExpiry(purchaseDate, serviceLifeMonths),
            updatedAt: serverTimestamp(),
            lastAuditId: auditRef.id
        });
        transaction.set(auditRef, {
            action: "component_updated",
            entityType: "component",
            entityId: componentId,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
}

export async function resolveFault(faultId, user, profile) {
    requireRole(profile, ["supervisor", "administrator"]);
    const faultRef = doc(db, "faults", faultId);
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        const fault = await transaction.get(faultRef);
        if (!fault.exists()) throw new Error("The selected fault was not found.");
        if (fault.data().status !== "open") throw new Error("This fault is already resolved.");
        transaction.update(faultRef, {
            status: "resolved",
            resolvedBy: user.uid,
            resolvedAt: serverTimestamp(),
            lastAuditId: auditRef.id
        });
        transaction.set(auditRef, {
            action: "fault_resolved",
            entityType: "fault",
            entityId: faultId,
            faultId,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
}

export async function resolveConflict(conflictId, user, profile) {
    requireRole(profile, ["administrator"]);
    const conflictRef = doc(db, "conflicts", conflictId);
    const auditRef = documentRef("auditLogs");
    await runTransaction(db, async (transaction) => {
        const conflict = await transaction.get(conflictRef);
        if (!conflict.exists()) throw new Error("The selected conflict was not found.");
        if (conflict.data().resolved) throw new Error("This conflict is already resolved.");
        transaction.update(conflictRef, { resolved: true, lastAuditId: auditRef.id });
        transaction.set(auditRef, {
            action: "conflict_resolved",
            entityType: "conflict",
            entityId: conflictId,
            performedBy: user.uid,
            performedByEmail: user.email || "",
            createdAt: serverTimestamp()
        });
    });
}

export async function syncOfflineActions(user, profile) {
    if (!navigator.onLine) {
        const result = { pendingCount: readOfflineQueue().length, failed: [], offline: true };
        window.dispatchEvent(new CustomEvent("pathfinder:offline-sync", { detail: result }));
        return result;
    }
    const queue = readOfflineQueue();
    const pending = [];
    const failed = [];
    for (const action of queue) {
        if (action.uid !== user.uid) {
            pending.push(action);
            continue;
        }
        try {
            if (action.type === "movement") {
                await recordMovement({
                    ...action.payload,
                    user,
                    profile,
                    eventId: action.eventId,
                    queueOffline: false
                });
            } else if (action.type === "fault") {
                await recordFault(
                    action.payload,
                    user,
                    profile,
                    { eventId: action.eventId, faultId: action.faultId },
                    false
                );
            } else {
                throw new Error(`Unknown offline action type: ${action.type}`);
            }
        } catch (error) {
            pending.push(action);
            failed.push({ action, message: error.message });
        }
    }
    saveOfflineQueue(pending);
    window.dispatchEvent(new CustomEvent("pathfinder:offline-sync", {
        detail: { pendingCount: pending.length, failed }
    }));
    return { pendingCount: pending.length, failed, offline: false };
}
