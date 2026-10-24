import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
    connectAuthEmulator,
    getAuth
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import {
    FIREBASE_EMULATOR_PROJECT_ID,
    useFirebaseEmulators
} from "./firebase-emulator.js";

const useEmulators = useFirebaseEmulators();
const appConfig = useEmulators
    ? { ...firebaseConfig, projectId: FIREBASE_EMULATOR_PROJECT_ID }
    : firebaseConfig;

export const app = getApps().length ? getApp() : initializeApp(appConfig);
export const auth = getAuth(app);

if (useEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}
