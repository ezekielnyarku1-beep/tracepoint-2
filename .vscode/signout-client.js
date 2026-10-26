import { signOut } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { auth } from "./firebase-auth-client.js";

const message = document.getElementById("signout-message");

try {
    sessionStorage.removeItem("pathfinder.verified-profile");
} catch (error) {
    console.warn("Could not clear the cached navigation profile.", error);
}

try {
    await signOut(auth);
    window.location.replace("./login.html");
} catch (error) {
    message.textContent = error?.code === "auth/network-request-failed"
        ? "Could not connect to Firebase. Check your internet connection and try again."
        : error?.message || "Could not sign out. Please try again.";
}
