import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    runTransaction,
    serverTimestamp,
    setDoc,
    updateDoc
} from "firebase/firestore";

const projectId = "demo-pathfinder";
const emulatorAddress = process.env.FIRESTORE_EMULATOR_HOST || "";
const [emulatorHost, emulatorPort] = emulatorAddress.split(":");
const usingLocalEmulator = ["127.0.0.1", "localhost"].includes(emulatorHost);

let testEnvironment;

before(async () => {
    if (!usingLocalEmulator) return;
    testEnvironment = await initializeTestEnvironment({
        projectId,
        firestore: {
            host: emulatorHost,
            port: Number(emulatorPort),
            rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8")
        }
    });
});

beforeEach(async () => {
    if (!usingLocalEmulator) return;
    await testEnvironment.clearFirestore();
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
        const firestore = context.firestore();
        const technicianPermissions = {
            dashboard: true,
            kiosks: true,
            components: true,
            "log-event": true,
            "fault-history": true,
            alerts: true,
            reports: true,
            users: false,
            "audit-log": false
        };
        await Promise.all([
            setDoc(doc(firestore, "users", "administrator"), {
                email: "admin@example.test",
                displayName: "Test Administrator",
                role: "administrator",
                permissions: Object.fromEntries(
                    Object.keys(technicianPermissions).map((key) => [key, true])
                ),
                createdAt: new Date()
            }),
            setDoc(doc(firestore, "users", "technician"), {
                email: "tech@example.test",
                displayName: "Test Technician",
                role: "technician",
                permissions: technicianPermissions,
                createdAt: new Date()
            }),
            setDoc(doc(firestore, "users", "supervisor"), {
                email: "supervisor@example.test",
                displayName: "Test Supervisor",
                role: "supervisor",
                permissions: technicianPermissions,
                createdAt: new Date()
            })
        ]);
    });
});

after(async () => {
    await testEnvironment?.cleanup();
});

test("an administrator can update multiple user permissions and audit them atomically", { skip: !usingLocalEmulator }, async () => {
    const firestore = testEnvironment.authenticatedContext("administrator").firestore();
    const permissions = {
        dashboard: false,
        kiosks: true,
        components: true,
        "log-event": true,
        "fault-history": true,
        alerts: true,
        reports: false,
        users: false,
        "audit-log": false
    };

    await assertSucceeds(runTransaction(firestore, async (transaction) => {
        transaction.update(doc(firestore, "users", "technician"), {
            permissions,
            updatedAt: serverTimestamp(),
            lastAuditId: "reports-permission-audit"
        });
        for (const [auditId, pageKey] of [
            ["dashboard-permission-audit", "dashboard"],
            ["reports-permission-audit", "reports"]
        ]) {
            transaction.set(doc(firestore, "auditLogs", auditId), {
                action: "user_permission_changed",
                entityType: "user",
                entityId: "technician",
                pageKey,
                oldValue: true,
                newValue: false,
                summary: `${pageKey} access changed from on to off.`,
                performedBy: "administrator",
                performedByEmail: "admin@example.test",
                createdAt: serverTimestamp()
            });
        }
    }));
    const updatedProfile = await getDoc(doc(firestore, "users", "technician"));
    assert.equal(updatedProfile.data().permissions.dashboard, false);
    assert.equal(updatedProfile.data().permissions.reports, false);
    await Promise.all([
        assertSucceeds(getDoc(doc(firestore, "auditLogs", "dashboard-permission-audit"))),
        assertSucceeds(getDoc(doc(firestore, "auditLogs", "reports-permission-audit")))
    ]);
});

test("a technician cannot change their own role or permissions", { skip: !usingLocalEmulator }, async () => {
    const firestore = testEnvironment.authenticatedContext("technician").firestore();
    const userRef = doc(firestore, "users", "technician");

    await assertFails(updateDoc(userRef, { role: "administrator" }));
    await assertFails(updateDoc(userRef, {
        permissions: {
            dashboard: true,
            kiosks: true,
            components: true,
            "log-event": true,
            "fault-history": true,
            alerts: true,
            reports: false,
            users: false,
            "audit-log": false
        }
    }));
});

test("users can read only their own profile unless they are an administrator", { skip: !usingLocalEmulator }, async () => {
    const technicianDb = testEnvironment.authenticatedContext("technician").firestore();
    const administratorDb = testEnvironment.authenticatedContext("administrator").firestore();

    await assertSucceeds(getDoc(doc(technicianDb, "users", "technician")));
    await assertFails(getDoc(doc(technicianDb, "users", "supervisor")));
    await assertSucceeds(getDoc(doc(administratorDb, "users", "technician")));
    await assertSucceeds(getDocs(collection(administratorDb, "users")));
});

test("users can record their own last sign-in and current activity only", { skip: !usingLocalEmulator }, async () => {
    const firestore = testEnvironment.authenticatedContext("technician").firestore();
    const ownProfile = doc(firestore, "users", "technician");
    const otherProfile = doc(firestore, "users", "supervisor");

    await assertSucceeds(updateDoc(ownProfile, {
        lastSignInAt: new Date(Date.now() - 60_000),
        lastActiveAt: serverTimestamp()
    }));
    await assertFails(updateDoc(otherProfile, {
        lastActiveAt: serverTimestamp()
    }));
    await assertFails(updateDoc(ownProfile, {
        lastActiveAt: new Date(Date.now() - 60_000)
    }));
    await assertFails(updateDoc(ownProfile, {
        lastSignInAt: new Date("2999-10-24T12:00:00.000Z")
    }));
});

test("signed-in users cannot create audit entries without a matching application change", { skip: !usingLocalEmulator }, async () => {
    const firestore = testEnvironment.authenticatedContext("technician").firestore();
    await assertFails(setDoc(doc(firestore, "auditLogs", "fabricated"), {
        action: "fabricated_action",
        entityType: "component",
        entityId: "component-1",
        summary: "This entry has no matching change.",
        performedBy: "technician",
        createdAt: serverTimestamp()
    }));
});

test("component and fault workflows commit history and audit records atomically", { skip: !usingLocalEmulator }, async () => {
    const technicianDb = testEnvironment.authenticatedContext("technician").firestore();
    const administratorDb = testEnvironment.authenticatedContext("administrator").firestore();

    await runTransaction(administratorDb, async (transaction) => {
        transaction.set(doc(administratorDb, "kiosks", "kiosk-1"), {
            location: "Building A",
            installedDate: "2026-01-01",
            status: "active",
            lastAuditId: "kiosk-audit",
            createdBy: "administrator",
            createdByEmail: "admin@example.test",
            createdAt: serverTimestamp()
        });
        transaction.set(doc(administratorDb, "auditLogs", "kiosk-audit"), {
            action: "kiosk_registered",
            entityType: "kiosk",
            entityId: "kiosk-1",
            performedBy: "administrator",
            performedByEmail: "admin@example.test",
            createdAt: serverTimestamp()
        });
    });

    await runTransaction(technicianDb, async (transaction) => {
        transaction.set(doc(technicianDb, "componentSerials", "serial-1"), {
            componentId: "component-1",
            serialNumber: "serial-1",
            createdBy: "technician",
            createdAt: serverTimestamp()
        });
        transaction.set(doc(technicianDb, "components", "component-1"), {
            type: "display",
            serialNumber: "serial-1",
            manufacturer: "",
            model: "",
            purchaseDate: "",
            warrantyStart: "",
            warrantyExpiry: "",
            serviceLifeMonths: 0,
            serviceLifeExpiry: "",
            currentKioskId: "",
            status: "in_storage",
            createdBy: "technician",
            createdByEmail: "tech@example.test",
            createdAt: serverTimestamp(),
            lastEventId: "",
            lastAuditId: "component-audit"
        });
        transaction.set(doc(technicianDb, "auditLogs", "component-audit"), {
            action: "component_registered",
            entityType: "component",
            entityId: "component-1",
            performedBy: "technician",
            performedByEmail: "tech@example.test",
            createdAt: serverTimestamp()
        });
    });

    await runTransaction(technicianDb, async (transaction) => {
        const componentRef = doc(technicianDb, "components", "component-1");
        await transaction.get(componentRef);
        await transaction.get(doc(technicianDb, "kiosks", "kiosk-1"));
        transaction.set(doc(technicianDb, "events", "movement-1"), {
            auditId: "movement-audit",
            eventType: "install",
            componentId: "component-1",
            kioskId: "kiosk-1",
            sourceKioskId: "",
            destinationKioskId: "kiosk-1",
            summary: "Initial install",
            notes: "",
            createdBy: "technician",
            createdByEmail: "tech@example.test",
            createdAt: serverTimestamp()
        });
        transaction.set(doc(technicianDb, "auditLogs", "movement-audit"), {
            action: "component_event",
            entityType: "component",
            entityId: "component-1",
            eventId: "movement-1",
            eventType: "install",
            summary: "Initial install",
            performedBy: "technician",
            performedByEmail: "tech@example.test",
            createdAt: serverTimestamp()
        });
        transaction.update(componentRef, {
            currentKioskId: "kiosk-1",
            status: "installed",
            lastEventId: "movement-1",
            lastAuditId: "movement-audit",
            updatedAt: serverTimestamp()
        });
    });

    await runTransaction(technicianDb, async (transaction) => {
        const faultRef = doc(technicianDb, "faults", "fault-1");
        const eventRef = doc(technicianDb, "events", "fault-event-1");
        const auditRef = doc(technicianDb, "auditLogs", "fault-audit-1");
        await transaction.get(doc(technicianDb, "components", "component-1"));
        transaction.set(faultRef, {
            targetType: "component",
            targetId: "component-1",
            componentId: "component-1",
            kioskId: "kiosk-1",
            summary: "Display flicker",
            description: "The display flickers intermittently.",
            severity: "medium",
            status: "open",
            reportedBy: "technician",
            reportedByEmail: "tech@example.test",
            createdAt: serverTimestamp(),
            lastEventId: eventRef.id,
            lastAuditId: auditRef.id
        });
        transaction.set(eventRef, {
            auditId: auditRef.id,
            eventType: "fault",
            faultId: faultRef.id,
            componentId: "component-1",
            kioskId: "kiosk-1",
            sourceKioskId: "kiosk-1",
            destinationKioskId: "",
            summary: "Display flicker",
            notes: "The display flickers intermittently.",
            createdBy: "technician",
            createdByEmail: "tech@example.test",
            createdAt: serverTimestamp()
        });
        transaction.set(auditRef, {
            action: "fault_reported",
            entityType: "component",
            entityId: "component-1",
            eventId: eventRef.id,
            faultId: faultRef.id,
            summary: "Display flicker",
            performedBy: "technician",
            performedByEmail: "tech@example.test",
            createdAt: serverTimestamp()
        });
    });

    const supervisorDb = testEnvironment.authenticatedContext("supervisor").firestore();
    await runTransaction(supervisorDb, async (transaction) => {
        const faultRef = doc(supervisorDb, "faults", "fault-1");
        await transaction.get(faultRef);
        transaction.update(faultRef, {
            status: "resolved",
            resolvedBy: "supervisor",
            resolvedAt: serverTimestamp(),
            lastAuditId: "resolved-audit"
        });
        transaction.set(doc(supervisorDb, "auditLogs", "resolved-audit"), {
            action: "fault_resolved",
            entityType: "fault",
            entityId: "fault-1",
            faultId: "fault-1",
            performedBy: "supervisor",
            performedByEmail: "supervisor@example.test",
            createdAt: serverTimestamp()
        });
    });
});
