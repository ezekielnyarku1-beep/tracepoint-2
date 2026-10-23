import {
    enableIndexedDbPersistence,
    getFirestore
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { app, auth } from "./firebase-auth-client.js";

export const db = getFirestore(app);

enableIndexedDbPersistence(db).catch((error) => {
    if (error.code === "failed-precondition") {
        console.warn("Offline database persistence is disabled because this app is open in multiple tabs.");
    } else if (error.code === "unimplemented") {
        console.warn("This browser does not support offline database persistence.");
    } else {
        console.error("Could not enable offline database persistence.", error);
    }
});
