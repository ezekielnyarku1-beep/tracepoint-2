import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
