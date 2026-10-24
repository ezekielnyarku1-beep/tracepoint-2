import {
    connectFirestoreEmulator,
    enableIndexedDbPersistence,
    getFirestore
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { app, auth } from "./firebase-auth-client.js";
import { useFirebaseEmulators } from "./firebase-emulator.js";

export const db = getFirestore(app);

if (useFirebaseEmulators()) {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

enableIndexedDbPersistence(db).catch((error) => {
    if (error.code === "failed-precondition") {
        console.warn("Offline database persistence is disabled because this app is open in multiple tabs.");
    } else if (error.code === "unimplemented") {
        console.warn("This browser does not support offline database persistence.");
    } else {
        console.error("Could not enable offline database persistence.", error);
    }
});
