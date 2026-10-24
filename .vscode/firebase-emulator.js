const emulatorModeKey = "pathfinder.firebaseEmulator";

export function useFirebaseEmulators() {
    const localHosts = ["localhost", "127.0.0.1"];
    if (!localHosts.includes(window.location.hostname.toLowerCase())) return false;

    const requestedMode = new URLSearchParams(window.location.search).get("emulator");
    if (requestedMode === "1") localStorage.setItem(emulatorModeKey, "true");
    if (requestedMode === "0") localStorage.removeItem(emulatorModeKey);
    return localStorage.getItem(emulatorModeKey) === "true";
}

export const FIREBASE_EMULATOR_PROJECT_ID = "demo-pathfinder";
