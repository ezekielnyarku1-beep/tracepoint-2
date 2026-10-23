// Firebase Web app configuration. These client-side values are public; never
// put a service-account key or other private server credentials in this file.
export const firebaseConfig = {
    apiKey: "AIzaSyBSmPa_N0fXYw659QuQGUv5Xs-2cm1E5cQ",
    authDomain: "tracepoint-629ea.firebaseapp.com",
    projectId: "tracepoint-629ea",
    storageBucket: "tracepoint-629ea.firebasestorage.app",
    messagingSenderId: "973634432978",
    appId: "1:973634432978:web:5d4ed86ac74ba792af220b",
    measurementId: "G-E54GBJ0GW2"
};

export const firebaseConfigured = Object.values(firebaseConfig).every(
    Boolean
);
