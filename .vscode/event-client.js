import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { auth, db } from "./firebase-client.js";
import {
    ensureUserProfile,
    loadComponent,
    loadComponentBySerialNumber,
    recordFault,
    recordMovement
} from "./data-service.js";

const form = document.getElementById("event-form");
const eventType = document.getElementById("event-type");
const componentInput = document.getElementById("component-id");
const componentStatus = document.getElementById("component-status");
const kioskSelect = document.getElementById("kiosk-id");
const kioskStatus = document.getElementById("kiosk-status");
const summaryInput = document.getElementById("event-summary");
const notesInput = document.getElementById("event-notes");
const formStatus = document.getElementById("event-form-status");
const submitButton = document.getElementById("submit-event");
const scanButton = document.getElementById("scan-button");
const scanStatus = document.getElementById("scan-status");
const scannerDialog = document.getElementById("scanner-dialog");
const scannerDialogStatus = document.getElementById("scanner-dialog-status");
const scannerVideo = document.getElementById("scanner-video");
const scannerCloseButton = document.getElementById("scanner-close");
const scannerCancelButton = document.getElementById("scanner-cancel");

let signedInUser = null;
let foundComponentId = "";
let foundComponent = null;
let userProfile = null;
let kioskListLoaded = false;
let isSubmitting = false;
let lookupSequence = 0;
let cameraStream = null;
let scannerTimer = null;
let barcodeDetector = null;
let fallbackReaderPromise = null;
let isScanning = false;

function setStatus(element, message, state = "") {
    element.textContent = message;
    if (state) element.dataset.state = state;
    else delete element.dataset.state;
}

function updateSubmitButton() {
    const needsKiosk = ["move", "install", "removal"].includes(eventType.value);
    submitButton.disabled =
        isSubmitting ||
        !signedInUser ||
        !userProfile ||
        (needsKiosk && (!kioskListLoaded || !kioskSelect.value));
    kioskSelect.required = needsKiosk;
    const requiredMarker = document.querySelector('label[for="kiosk-id"] span');
    if (requiredMarker) requiredMarker.hidden = !needsKiosk;
}

function syncKioskForEventType() {
    const currentKiosk = foundComponent?.currentKioskId || "";
    const usesCurrentKiosk = ["removal", "decommission", "maintenance", "fault"].includes(eventType.value);
    const preferredKiosk = usesCurrentKiosk ? currentKiosk : "";
    const hasOption = [...kioskSelect.options].some((option) => option.value === preferredKiosk);
    kioskSelect.value = hasOption ? preferredKiosk : "";
    updateSubmitButton();
}

function firestoreErrorMessage(action, error) {
    console.error(`${action} failed`, error);
    const errorCode = error?.code ? ` (${error.code})` : "";
    return `${action} Check your Firestore database and security rules${errorCode}.`;
}

async function loadKiosks() {
    kioskListLoaded = false;
    updateSubmitButton();
    kioskSelect.disabled = true;
    kioskSelect.replaceChildren(new Option("Loading kiosks…", ""));
    setStatus(kioskStatus, "Loading kiosks from inventory…");

    try {
        const kioskSnapshot = await getDocs(collection(db, "kiosks"));
        const kiosks = kioskSnapshot.docs
            .filter((kiosk) => kiosk.data().status !== "inactive")
            .map((kiosk) => kiosk.id)
            .sort((a, b) => a.localeCompare(b));
        kioskSelect.replaceChildren(new Option(
            kiosks.length ? "Choose a kiosk" : "No kiosks found",
            ""
        ));
        for (const kioskId of kiosks) {
            kioskSelect.add(new Option(kioskId, kioskId));
        }
        kioskSelect.disabled = kiosks.length === 0;
        kioskListLoaded = true;
        setStatus(
            kioskStatus,
            kiosks.length
                ? `${kiosks.length} kiosk${kiosks.length === 1 ? "" : "s"} available.`
                : "No kiosk records were found in the kiosks collection.",
            kiosks.length ? "success" : "error"
        );
    } catch (error) {
        kioskSelect.replaceChildren(new Option("Kiosk list unavailable", ""));
        setStatus(
            kioskStatus,
            firestoreErrorMessage("Could not load kiosks.", error),
            "error"
        );
    }
    updateSubmitButton();
}

async function lookupComponent() {
    const componentId = componentInput.value.trim();
    const sequence = ++lookupSequence;
    foundComponentId = "";
    foundComponent = null;
    componentInput.value = componentId;

    if (!componentId) {
        setStatus(componentStatus, "");
        return false;
    }

    if (!signedInUser) {
        setStatus(componentStatus, "Sign in to look up components.", "error");
        return false;
    }

    setStatus(componentStatus, "Looking up component…");
    try {
        const component = await loadComponent(componentId) ||
            await loadComponentBySerialNumber(componentId);
        if (sequence !== lookupSequence) return false;
        if (!component) {
            setStatus(componentStatus, "No matching component was found.", "error");
            return false;
        }
        foundComponentId = component.id;
        foundComponent = component;
        componentInput.value = component.id;
        syncKioskForEventType();
        setStatus(componentStatus, "Component found.", "success");
        return true;
    } catch (error) {
        if (sequence !== lookupSequence) return false;
        setStatus(
            componentStatus,
            firestoreErrorMessage("Could not look up the component.", error),
            "error"
        );
        return false;
    }
}

function stopCamera() {
    isScanning = false;
    if (scannerTimer !== null) {
        window.clearTimeout(scannerTimer);
        scannerTimer = null;
    }
    if (cameraStream) {
        for (const track of cameraStream.getTracks()) track.stop();
        cameraStream = null;
    }
    barcodeDetector = null;
    scannerVideo.pause();
    scannerVideo.srcObject = null;
}

function closeScanner() {
    stopCamera();
    if (scannerDialog.open) scannerDialog.close();
    scanButton.focus();
}

function waitForVideoReady(video) {
    if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            window.clearTimeout(timeout);
            video.removeEventListener("loadedmetadata", checkReady);
            video.removeEventListener("playing", checkReady);
            video.removeEventListener("resize", checkReady);
            video.removeEventListener("error", handleError);
        };
        const checkReady = () => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
                cleanup();
                resolve();
            }
        };
        const handleError = () => {
            cleanup();
            reject(new Error("The camera video could not be started."));
        };
        const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error("The camera did not provide a video frame."));
        }, 10000);

        video.addEventListener("loadedmetadata", checkReady);
        video.addEventListener("playing", checkReady);
        video.addEventListener("resize", checkReady);
        video.addEventListener("error", handleError);
        checkReady();
    });
}

function loadFallbackReader() {
    if (window.ZXingBrowser?.BrowserMultiFormatReader) {
        return Promise.resolve(window.ZXingBrowser.BrowserMultiFormatReader);
    }
    if (fallbackReaderPromise) return fallbackReaderPromise;

    fallbackReaderPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js";
        script.async = true;
        script.onload = () => {
            const Reader = window.ZXingBrowser?.BrowserMultiFormatReader;
            if (Reader) {
                resolve(Reader);
            } else {
                reject(new Error("The barcode decoder did not load correctly."));
            }
        };
        script.onerror = () => reject(new Error("Could not download the barcode decoder."));
        document.head.append(script);
    }).catch((error) => {
        fallbackReaderPromise = null;
        throw error;
    });

    return fallbackReaderPromise;
}

function componentLookupValue(scannedValue) {
    const value = String(scannedValue || "").trim();
    if (!value) return "";

    if (value.startsWith("{") || value.startsWith('"')) {
        try {
            const payload = JSON.parse(value);
            if (typeof payload === "string") return payload.trim();
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                const identifiers = new Map(
                    Object.entries(payload).map(([key, identifier]) => [
                        key.toLowerCase().replace(/[_-]/g, ""),
                        identifier
                    ])
                );
                for (const key of ["componentid", "serialnumber", "serial", "assetid", "id"]) {
                    const identifier = identifiers.get(key);
                    if (typeof identifier === "string" || typeof identifier === "number") {
                        return String(identifier).trim();
                    }
                }
            }
        } catch {
            // Most barcodes contain plain text rather than JSON.
        }
    }

    try {
        const url = new URL(value, window.location.origin);
        for (const [key, identifier] of url.searchParams) {
            if (["componentid", "serialnumber", "serial", "assetid", "id"].includes(
                key.toLowerCase().replace(/[_-]/g, "")
            )) {
                return identifier.trim();
            }
        }

        const segments = url.pathname.split("/").filter(Boolean);
        const componentSegment = segments.findIndex((segment) =>
            ["component", "components", "asset", "assets"].includes(decodeURIComponent(segment).toLowerCase())
        );
        if (componentSegment >= 0 && segments[componentSegment + 1]) {
            return decodeURIComponent(segments[componentSegment + 1]).trim();
        }
    } catch {
        // Keep the original scanned value if it is not a recognized URL.
    }

    return value;
}

async function startFallbackScanning() {
    const FallbackReader = await loadFallbackReader();
    if (!scannerDialog.open || !isScanning) return;

    const reader = new FallbackReader();
    const result = await reader.decodeFromVideoElement(scannerVideo);
    if (result && scannerDialog.open && isScanning) {
        await handleScannedValue(result.getText());
    }
}

async function handleScannedValue(scannedValue) {
    if (!isScanning || !scannedValue) return;
    stopCamera();
    if (scannerDialog.open) scannerDialog.close();
    componentInput.value = componentLookupValue(scannedValue);
    setStatus(scanStatus, "Code scanned. Checking component…");
    componentInput.focus();
    const componentFound = await lookupComponent();
    setStatus(
        scanStatus,
        componentFound
            ? "Code scanned and component found."
            : "Code scanned, but the component could not be verified."
    );
}

async function scanFrame() {
    if (!isScanning || !barcodeDetector) return;
    try {
        if (scannerVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const barcodes = await barcodeDetector.detect(scannerVideo);
            const scannedValue = barcodes.find((barcode) => barcode.rawValue)?.rawValue;
            if (scannedValue) {
                await handleScannedValue(scannedValue);
                return;
            }
        }
        scannerTimer = window.setTimeout(scanFrame, 180);
    } catch (error) {
        console.error("Barcode scanning failed", error);
        barcodeDetector = null;
        scannerDialogStatus.textContent = "Switching to compatibility barcode support…";
        try {
            await startFallbackScanning();
        } catch (fallbackError) {
            console.error("Compatibility barcode scanning failed", fallbackError);
            stopCamera();
            scannerDialogStatus.textContent =
                "Could not read codes with this camera. Try again or enter the component ID or serial number manually.";
        }
    }
}

async function startScanner() {
    if (scannerDialog.open) return;
    setStatus(scanStatus, "");
    const Detector = window.BarcodeDetector;
    if (!window.isSecureContext) {
        setStatus(
            scanStatus,
            "Camera scanning requires HTTPS or localhost. Enter the component ID or serial number manually.",
            "error"
        );
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(
            scanStatus,
            "Camera access is unavailable in this browser. Enter the component ID or serial number manually.",
            "error"
        );
        return;
    }

    scannerDialogStatus.textContent = "Preparing barcode scanner…";
    scannerDialog.showModal();
    try {
        if (Detector) {
            try {
                const supportedFormats = await Detector.getSupportedFormats();
                const preferredFormats = [
                    "qr_code",
                    "code_128",
                    "code_39",
                    "ean_13",
                    "ean_8",
                    "upc_a",
                    "upc_e",
                    "itf",
                    "data_matrix",
                    "pdf417",
                    "aztec"
                ].filter((format) => supportedFormats.includes(format));
                if (preferredFormats.length) {
                    barcodeDetector = new Detector({ formats: preferredFormats });
                }
            } catch (error) {
                console.warn("Native barcode detection is unavailable; using the fallback decoder.", error);
            }
        }

        if (!barcodeDetector) {
            scannerDialogStatus.textContent = "Loading barcode support…";
            await loadFallbackReader();
            if (!scannerDialog.open) return;
        }

        scannerDialogStatus.textContent = "Requesting camera access…";
        cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: "environment" } }
        });
        if (!scannerDialog.open) {
            stopCamera();
            return;
        }
        scannerVideo.srcObject = cameraStream;
        await scannerVideo.play();
        if (!scannerDialog.open) {
            stopCamera();
            return;
        }
        await waitForVideoReady(scannerVideo);
        if (!scannerDialog.open) {
            stopCamera();
            return;
        }
        scannerDialogStatus.textContent = "Point the camera at a component label.";
        isScanning = true;
        if (barcodeDetector) {
            scanFrame();
        } else {
            await startFallbackScanning();
        }
    } catch (error) {
        console.error("Could not start the barcode scanner", error);
        stopCamera();
        const detail = error?.message ? ` ${error.message}` : "";
        scannerDialogStatus.textContent = error?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access or enter the component ID manually."
            : error?.message?.includes("barcode decoder")
                ? `Could not load barcode support. Check your internet connection and try again.${detail}`
                : `Could not start scanning. Check camera access or enter the component ID or serial number manually.${detail}`;
    }
}

componentInput.addEventListener("change", lookupComponent);
componentInput.addEventListener("input", () => {
    lookupSequence += 1;
    foundComponentId = "";
    foundComponent = null;
    setStatus(componentStatus, "");
    setStatus(scanStatus, "");
});
eventType.addEventListener("change", syncKioskForEventType);
kioskSelect.addEventListener("change", updateSubmitButton);
scanButton.addEventListener("click", startScanner);
scannerCloseButton.addEventListener("click", closeScanner);
scannerCancelButton.addEventListener("click", closeScanner);
scannerDialog.addEventListener("close", stopCamera);
scannerDialog.addEventListener("click", (event) => {
    if (event.target === scannerDialog) closeScanner();
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden && scannerDialog.open) closeScanner();
});
window.addEventListener("pagehide", stopCamera);

form.addEventListener("reset", () => {
    lookupSequence += 1;
    foundComponentId = "";
    foundComponent = null;
    setStatus(componentStatus, "");
    setStatus(formStatus, "");
    setStatus(scanStatus, "");
    window.setTimeout(updateSubmitButton, 0);
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(formStatus, "");
    if (!form.reportValidity()) return;
    if (!signedInUser) {
        setStatus(formStatus, "Please sign in again before logging an event.", "error");
        return;
    }

    if (foundComponentId !== componentInput.value.trim()) {
        const componentFound = await lookupComponent();
        if (!componentFound) {
            setStatus(formStatus, "Select a component that exists in inventory before logging this event.", "error");
            componentInput.focus();
            return;
        }
    }
    const needsKiosk = ["move", "install", "removal"].includes(eventType.value);
    if (needsKiosk && (!kioskListLoaded || !kioskSelect.value)) {
        setStatus(formStatus, "Choose a kiosk from the available inventory.", "error");
        kioskSelect.focus();
        return;
    }

    isSubmitting = true;
    updateSubmitButton();
    submitButton.textContent = "Saving event…";
    try {
        const chosenKiosk = kioskSelect.value;
        const currentKiosk = foundComponent?.currentKioskId || "";
        const common = {
            componentId: foundComponentId,
            summary: summaryInput.value.trim(),
            notes: notesInput.value.trim(),
            user: signedInUser,
            profile: userProfile
        };
        let result;
        if (eventType.value === "fault") {
            result = await recordFault({
                targetType: "component",
                targetId: foundComponentId,
                summary: summaryInput.value.trim(),
                description: notesInput.value.trim() || summaryInput.value.trim(),
                severity: "medium"
            }, signedInUser, userProfile);
        } else {
            const sourceKioskId = ["move", "removal", "decommission"].includes(eventType.value)
                ? eventType.value === "removal" ? chosenKiosk : currentKiosk
                : eventType.value === "maintenance"
                    ? currentKiosk
                    : "";
            const destinationKioskId = ["move", "install"].includes(eventType.value)
                ? chosenKiosk
                : eventType.value === "maintenance"
                    ? currentKiosk
                    : "";
            result = await recordMovement({
                ...common,
                eventType: eventType.value,
                sourceKioskId,
                destinationKioskId
            });
        }
        form.reset();
        setStatus(formStatus, result?.pending
            ? "Event saved on this device and will sync when you are back online."
            : "Event logged successfully.", "success");
    } catch (error) {
        if (error?.code) {
            setStatus(formStatus, firestoreErrorMessage("Could not save the event.", error), "error");
        } else {
            console.error("Could not save the event.", error);
            setStatus(formStatus, error.message || "Could not save the event.", "error");
        }
    } finally {
        isSubmitting = false;
        submitButton.textContent = "Log event";
        updateSubmitButton();
    }
});

onAuthStateChanged(auth, async (user) => {
    signedInUser = user;
    if (user) {
        try {
            userProfile = await ensureUserProfile(user);
            await loadKiosks();
        } catch (error) {
            setStatus(formStatus, firestoreErrorMessage("Could not load your account profile.", error), "error");
        }
    }
}, (error) => {
    setStatus(
        formStatus,
        `Could not confirm your sign-in. Refresh the page or sign in again. ${error?.code || ""}`,
        "error"
    );
});

document.addEventListener("pathfinder:offline-queue", (event) => {
    if (event.detail.pendingCount) {
        setStatus(formStatus, `${event.detail.pendingCount} action(s) are saved on this device and waiting to sync.`, "success");
    }
});

document.addEventListener("pathfinder:offline-sync", (event) => {
    if (event.detail.failed.length) {
        const firstError = event.detail.failed[0].message;
        setStatus(formStatus, `${event.detail.failed.length} saved action(s) could not sync: ${firstError}`, "error");
    } else if (event.detail.offline && event.detail.pendingCount) {
        setStatus(formStatus, `${event.detail.pendingCount} saved action(s) are waiting to sync when you reconnect.`, "success");
    } else if (event.detail.pendingCount === 0) {
        setStatus(formStatus, "All saved offline actions have synced.", "success");
    }
});
