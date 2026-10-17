import {
    browserLocalPersistence,
    browserSessionPersistence,
    createUserWithEmailAndPassword,
    EmailAuthProvider,
    onAuthStateChanged,
    reauthenticateWithCredential,
    sendPasswordResetEmail,
    setPersistence,
    signInWithEmailAndPassword,
    signOut,
    updatePassword,
    updateProfile,
    verifyPasswordResetCode,
    confirmPasswordReset
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { auth } from "./firebase-auth-client.js";
import { db } from "./firebase-client.js";
const themePreferenceKey = "tracepoint-theme";
let accountCreationInProgress = false;
let adminLoginInProgress = false;
let offlineSyncContext = null;
let authStateSequence = 0;

function friendlyAuthError(error) {
    switch (error.code) {
        case "auth/invalid-credential":
        case "auth/invalid-login-credentials":
        case "auth/user-not-found":
        case "auth/wrong-password":
            return "Email or password is incorrect.";
        case "auth/email-already-in-use":
            return "An account already exists for this email address. Try signing in instead.";
        case "auth/weak-password":
            return "Your password must contain at least 6 characters.";
        case "auth/invalid-email":
            return "Enter a valid email address.";
        case "auth/too-many-requests":
            return "Too many attempts. Please wait a little and try again.";
        case "auth/network-request-failed":
            return "Could not connect to Firebase. Check your internet connection and try again.";
        case "auth/unauthorized-domain":
            return "This website address is not authorized in Firebase. Add it under Authentication settings in the Firebase console.";
        case "auth/configuration-not-found":
        case "auth/operation-not-allowed":
            return "Email and password sign-in is not enabled for this Firebase project. Enable it in Firebase Authentication settings.";
        case "auth/invalid-action-code":
        case "auth/expired-action-code":
            return "This password reset link has expired or was already used. Request a new one.";
        default:
            return error.message || "The request could not be completed. Please try again.";
    }
}

function setFieldError(input, output, message) {
    output.textContent = message;
    output.hidden = !message;
    input.setAttribute("aria-invalid", String(Boolean(message)));
    if (message) input.setAttribute("aria-describedby", output.id);
    else input.removeAttribute("aria-describedby");
}

function setupLoginPage() {
    const form = document.getElementById("login-form") ||
        document.getElementById("admin-login-form");
    if (!form) return;

    const isAdminLoginPage = form.id === "admin-login-form";
    const email = document.getElementById("email");
    const password = document.getElementById("password");
    const emailError = document.getElementById("email-error");
    const passwordError = document.getElementById("password-error");
    const capsWarning = document.getElementById("caps-warning");
    const status = document.getElementById("login-status");
    const submit = document.getElementById("submit-button");
    const label = document.getElementById("button-label");
    const spinner = document.getElementById("button-spinner");
    const toggle = document.getElementById("password-toggle");
    const modeToggle = document.getElementById("login-mode-toggle");
    const modeOptions = modeToggle
        ? [...modeToggle.querySelectorAll("[data-mode]")]
        : [];
    const loginHeading = document.getElementById("login-heading");
    const signupPrompt = document.getElementById("signup-prompt");

    function setLoginMode(mode, focusOption = false) {
        if (!modeToggle || isAdminLoginPage) return;
        const isAdminMode = mode === "admin";
        modeToggle.dataset.mode = mode;
        form.dataset.loginMode = mode;
        modeOptions.forEach((option) => {
            const isSelected = option.dataset.mode === mode;
            option.setAttribute("aria-checked", String(isSelected));
            option.tabIndex = isSelected ? 0 : -1;
            if (focusOption && isSelected) option.focus();
        });
        if (loginHeading) loginHeading.textContent = isAdminMode ? "Admin sign-in" : "Welcome back";
        if (signupPrompt) signupPrompt.hidden = isAdminMode;
        status.textContent = "";
    }

    if (modeToggle && !isAdminLoginPage) {
        setLoginMode("user");
        modeOptions.forEach((option) => {
            option.addEventListener("click", () => setLoginMode(option.dataset.mode));
            option.addEventListener("keydown", (event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const nextMode = event.key === "Home"
                    ? "user"
                    : event.key === "End"
                        ? "admin"
                        : option.dataset.mode === "user"
                            ? "admin"
                            : "user";
                setLoginMode(nextMode, true);
            });
        });
    }

    function validateEmail() {
        const message = !email.value.trim()
            ? "Enter your email address."
            : email.validity.typeMismatch
                ? "Enter a valid email address."
                : "";
        setFieldError(email, emailError, message);
        return !message;
    }

    function validatePassword() {
        const message = password.value ? "" : "Enter your password.";
        setFieldError(password, passwordError, message);
        const describedBy = [
            message ? passwordError.id : "",
            !capsWarning || capsWarning.hidden ? "" : capsWarning.id
        ].filter(Boolean);
        if (describedBy.length) password.setAttribute("aria-describedby", describedBy.join(" "));
        else password.removeAttribute("aria-describedby");
        return !message;
    }

    email.addEventListener("blur", validateEmail);
    email.addEventListener("input", () => {
        status.textContent = "";
        if (email.getAttribute("aria-invalid") === "true") validateEmail();
    });
    password.addEventListener("blur", validatePassword);
    password.addEventListener("input", () => {
        status.textContent = "";
        if (password.getAttribute("aria-invalid") === "true") validatePassword();
    });

    toggle?.addEventListener("click", () => {
        const showPassword = password.type === "password";
        password.type = showPassword ? "text" : "password";
        toggle.setAttribute("aria-pressed", String(showPassword));
        toggle.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
        const toggleText = document.getElementById("password-toggle-text");
        if (toggleText) toggleText.textContent = showPassword ? "Hide" : "Show";
        const eyeIcon = document.getElementById("eye-icon");
        const eyeOffIcon = document.getElementById("eye-off-icon");
        if (eyeIcon) eyeIcon.hidden = showPassword;
        if (eyeOffIcon) eyeOffIcon.hidden = !showPassword;
        password.focus();
    });

    function updateCapsWarning(event) {
        if (!capsWarning) return;
        capsWarning.hidden = !(event.getModifierState && event.getModifierState("CapsLock"));
        validatePassword();
    }
    password.addEventListener("keydown", updateCapsWarning);
    password.addEventListener("keyup", updateCapsWarning);
    password.addEventListener("focus", updateCapsWarning);
    password.addEventListener("blur", () => {
        capsWarning.hidden = true;
        validatePassword();
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        status.textContent = "";
        if (!validateEmail() || !validatePassword()) return;

        submit.disabled = true;
        if (spinner) spinner.hidden = false;
        label.textContent = "Signing in...";
        try {
            const rememberMe = document.getElementById("remember");
            await setPersistence(
                auth,
                rememberMe?.checked
                    ? browserLocalPersistence
                    : browserSessionPersistence
            );
            if (modeToggle && !isAdminLoginPage) {
                form.dataset.pendingLoginMode = form.dataset.loginMode || "user";
            }
            if (isAdminLoginPage) {
                adminLoginInProgress = true;
                const credential = await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
                await verifyAdminAccess(credential.user, status);
            } else {
                await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
            }
        } catch (error) {
            delete form.dataset.pendingLoginMode;
            status.textContent = friendlyAuthError(error);
        } finally {
            adminLoginInProgress = false;
            submit.disabled = false;
            if (spinner) spinner.hidden = true;
            label.textContent = "Sign in";
        }
    });

    if (new URLSearchParams(window.location.search).has("setup")) {
        status.textContent = "Email and password sign-in is not enabled in Firebase Authentication.";
    }
}

function setupSignupPage() {
    const form = document.getElementById("signup-form");
    if (!form) return;

    const message = document.getElementById("signup-message");
    const button = form.querySelector("button[type='submit']");
    const label = document.getElementById("signup-button-label");
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        button.disabled = true;
        label.textContent = "Creating account...";
        message.textContent = "";
        accountCreationInProgress = true;
        try {
            const name = document.getElementById("name").value.trim();
            if (!name) {
                throw new Error("Enter your name.");
            }
            const credential = await createUserWithEmailAndPassword(
                auth,
                document.getElementById("email").value.trim(),
                document.getElementById("password").value
            );
            await updateProfile(credential.user, { displayName: name });
            const { ensureUserProfile } = await import("./data-service.js");
            await ensureUserProfile(credential.user);
            window.location.assign(resolveAppPath("index.html"));
        } catch (error) {
            message.textContent = friendlyAuthError(error);
        } finally {
            accountCreationInProgress = false;
            button.disabled = false;
            label.textContent = "Sign up";
        }
    });
}

async function denyAdminSignIn(status) {
    const message = "This account does not have admin or supervisor access.";
    try {
        await signOut(auth);
        status.textContent = message;
    } catch (error) {
        console.error("Could not sign out an account without an authorized role.", error);
        status.textContent = `${message} ${friendlyAuthError(error)}`;
    }
}

async function verifyAdminAccess(user, status) {
    try {
        const profileSnapshot = await getDoc(doc(db, "users", user.uid));
        const role = profileSnapshot.exists() ? profileSnapshot.data().role : "";
        if (!["supervisor", "administrator"].includes(role)) {
            await denyAdminSignIn(status);
            return;
        }
        if (auth.currentUser?.uid === user.uid) {
            window.location.assign(resolveAppPath("index.html"));
        }
    } catch (error) {
        if (auth.currentUser?.uid === user.uid && status) {
            status.textContent = profileLoadErrorMessage(error);
        }
    }
}

function setupForgotPasswordPage() {
    const form = document.getElementById("reset-form");
    if (!form) return;
    const button = document.getElementById("reset-button");
    const message = document.getElementById("reset-message");

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        button.disabled = true;
        message.textContent = "";
        try {
            await sendPasswordResetEmail(auth, document.getElementById("email").value.trim());
            message.textContent = "If an account exists for that email, a password reset email will be sent.";
        } catch (error) {
            message.textContent = error.code === "auth/user-not-found"
                ? "If an account exists for that email, a password reset email will be sent."
                : friendlyAuthError(error);
        } finally {
            button.disabled = false;
        }
    });
}

function setupResetPasswordPage() {
    const form = document.getElementById("new-password-form");
    if (!form) return;
    const button = document.getElementById("reset-password-button");
    const message = document.getElementById("new-password-message");
    const actionCode = new URLSearchParams(window.location.search).get("oobCode");

    if (!actionCode) {
        message.textContent = "This password reset link is invalid or expired. Request a new one.";
        button.disabled = true;
        return;
    }

    verifyPasswordResetCode(auth, actionCode).catch((error) => {
        message.textContent = friendlyAuthError(error);
        button.disabled = true;
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        button.disabled = true;
        message.textContent = "";
        try {
            await confirmPasswordReset(
                auth,
                actionCode,
                document.getElementById("new-password").value
            );
            message.textContent = "Your password has been reset. You can now sign in.";
            form.reset();
        } catch (error) {
            message.textContent = friendlyAuthError(error);
        } finally {
            button.disabled = false;
        }
    });
}

function enableThemeSwitch() {
    const navigation = document.querySelector("nav");
    if (!navigation || document.querySelector(".nav-theme")) return;

    const initialTheme = localStorage.getItem(themePreferenceKey) === "dark" ? "dark" : "light";
    document.body.dataset.theme = initialTheme;
    const themeButton = document.createElement("button");
    themeButton.className = "nav-theme";
    themeButton.type = "button";
    themeButton.textContent = "</>";

    const updateLabel = () => {
        const isDark = document.body.dataset.theme === "dark";
        themeButton.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
        themeButton.title = `Switch to ${isDark ? "light" : "dark"} mode`;
        themeButton.setAttribute("aria-pressed", String(isDark));
    };
    updateLabel();
    themeButton.addEventListener("click", () => {
        const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
        document.body.dataset.theme = nextTheme;
        localStorage.setItem(themePreferenceKey, nextTheme);
        updateLabel();
    });
    document.body.append(themeButton);
}

function setupAccountPage() {
    const form = document.getElementById("account-form");
    if (!form) return;

    const nameInput = document.getElementById("display-name");
    const currentPassword = document.getElementById("current-password");
    const newPassword = document.getElementById("new-password");
    const confirmPassword = document.getElementById("confirm-password");
    const status = document.getElementById("account-status");
    const submit = document.getElementById("account-save-button");
    const defaultButtonLabel = submit.textContent.trim();

    const setStatus = (message, state = "error") => {
        status.textContent = message;
        if (message) status.dataset.state = state;
        else delete status.dataset.state;
    };

    const validatePasswordConfirmation = () => {
        confirmPassword.setCustomValidity(
            confirmPassword.value === newPassword.value
                ? ""
                : "The new passwords do not match."
        );
    };

    newPassword.addEventListener("input", validatePasswordConfirmation);
    confirmPassword.addEventListener("input", validatePasswordConfirmation);
    form.addEventListener("input", () => setStatus(""));

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("");
        validatePasswordConfirmation();

        const name = nameInput.value.trim();
        const hasPasswordChange = Boolean(newPassword.value || confirmPassword.value);

        if (!name) {
            setStatus("Enter your name.");
            nameInput.focus();
            return;
        }
        if (hasPasswordChange && !currentPassword.value) {
            setStatus("Enter your current password to change it.");
            currentPassword.focus();
            return;
        }
        if (hasPasswordChange && !newPassword.value) {
            setStatus("Enter a new password.");
            newPassword.focus();
            return;
        }
        if (!form.reportValidity()) return;

        const user = auth.currentUser;
        if (!user) {
            setStatus("Please sign in again before updating your account.");
            return;
        }
        if (hasPasswordChange && !user.email) {
            setStatus("A password cannot be changed for this account.");
            return;
        }

        submit.disabled = true;
        submit.textContent = "Saving...";
        let passwordUpdated = false;

        try {
            if (hasPasswordChange) {
                const credential = EmailAuthProvider.credential(
                    user.email,
                    currentPassword.value
                );
                await reauthenticateWithCredential(user, credential);
                await updatePassword(user, newPassword.value);
                passwordUpdated = true;
            }

            const nameUpdated = name !== (user.displayName || "");
            if (nameUpdated) {
                await updateProfile(user, { displayName: name });
            }

            currentPassword.value = "";
            newPassword.value = "";
            confirmPassword.value = "";
            setStatus(
                passwordUpdated
                    ? "Your account details and password have been updated."
                    : nameUpdated
                        ? "Your account details have been updated."
                        : "Your account settings are already up to date.",
                "success"
            );
        } catch (error) {
            const message = error.code === "auth/invalid-credential"
                ? "Your current password is incorrect."
                : friendlyAuthError(error);
            setStatus(
                passwordUpdated
                    ? `Your password was updated, but the profile could not be saved. ${message}`
                    : message
            );
        } finally {
            submit.disabled = false;
            submit.textContent = defaultButtonLabel;
        }
    });
}

async function setupSignoutPage() {
    const message = document.getElementById("signout-message");
    if (!message) return;
    try {
        await signOut(auth);
        window.location.replace(resolveAppPath("login.html"));
    } catch (error) {
        message.textContent = friendlyAuthError(error);
    }
}

async function handleAuthState(user) {
    const sequence = ++authStateSequence;
    const isLoginPage = Boolean(document.getElementById("login-form"));
    const isAdminLoginPage = Boolean(document.getElementById("admin-login-form"));
    const loginForm = document.getElementById("login-form");
    const requiresAdminMode = () => isAdminLoginPage ||
        loginForm?.dataset.pendingLoginMode === "admin" ||
        loginForm?.dataset.loginMode === "admin";
    const isSignupPage = Boolean(document.getElementById("signup-form"));
    const isProtectedPage = Boolean(document.querySelector("nav"));

    if (window.pathfinderProfileError || window.pathfinderAuthError) {
        window.pathfinderProfileError = null;
        window.pathfinderAuthError = null;
    }
    if (user && isSignupPage && accountCreationInProgress) return;
    if (user && isSignupPage) {
        try {
            const { ensureUserProfile } = await import("./data-service.js");
            await ensureUserProfile(user);
        } catch (error) {
            document.getElementById("signup-message").textContent =
                `Your account was created, but profile setup failed. ${friendlyAuthError(error)}`;
            return;
        }
        window.location.replace(resolveAppPath("index.html"));
        return;
    }
    if (user && isAdminLoginPage) {
        if (adminLoginInProgress) return;
        const submit = document.getElementById("submit-button");
        const label = document.getElementById("button-label");
        const status = document.getElementById("login-status");
        adminLoginInProgress = true;
        submit.disabled = true;
        label.textContent = "Checking access...";
        try {
            await verifyAdminAccess(user, status);
        } finally {
            adminLoginInProgress = false;
            if (auth.currentUser?.uid === user.uid) {
                submit.disabled = false;
                label.textContent = "Sign in";
            }
        }
        return;
    }
    if (user && (isLoginPage || isAdminLoginPage)) {
        const status = document.getElementById("login-status");
        try {
            const { ensureUserProfile } = await import("./data-service.js");
            const profile = await ensureUserProfile(user);
            if (sequence !== authStateSequence || auth.currentUser?.uid !== user.uid) return;
            if (
                requiresAdminMode() &&
                !["supervisor", "administrator"].includes(profile.role)
            ) {
                await denyAdminSignIn(status);
                return;
            }
            window.location.assign(resolveAppPath("index.html"));
        } catch (error) {
            if (sequence !== authStateSequence || auth.currentUser?.uid !== user.uid) return;
            if (
                requiresAdminMode() &&
                error?.message === "Your account profile is missing a valid role. Ask an administrator to review it."
            ) {
                await denyAdminSignIn(status);
                return;
            }
            if (status) status.textContent = profileLoadErrorMessage(error);
        }
        return;
    }
    if (!user && isProtectedPage) {
        offlineSyncContext = null;
        window.pathfinderProfileError = null;
        window.pathfinderAuthError = null;
        delete document.body.dataset.userRole;
        delete window.pathfinderProfile;
        window.location.replace(resolveAppPath("login.html"));
        return;
    }
    if (!user) {
        offlineSyncContext = null;
        window.pathfinderProfileError = null;
        window.pathfinderAuthError = null;
        delete document.body.dataset.userRole;
        delete window.pathfinderProfile;
        return;
    }

    enableThemeSwitch();
    const protectedPage = document.querySelector("main[data-page], #event-form");
    if (protectedPage) {
        let profile;
        let syncOfflineActions;
        try {
            const dataService = await import("./data-service.js");
            profile = await dataService.ensureUserProfile(user);
            syncOfflineActions = dataService.syncOfflineActions;
        } catch (error) {
            if (sequence !== authStateSequence || auth.currentUser?.uid !== user.uid) return;
            window.pathfinderProfileError = error;
            window.pathfinderAuthError = null;
            console.error("Could not load the signed-in user's profile.", error);
            const status = document.getElementById("account-status");
            if (status) {
                status.textContent = profileLoadErrorMessage(error);
            }
            document.dispatchEvent(new CustomEvent("pathfinder:profile-error", { detail: { error } }));
            return;
        }
        if (sequence !== authStateSequence || auth.currentUser?.uid !== user.uid) return;

        window.pathfinderProfileError = null;
        window.pathfinderAuthError = null;
        offlineSyncContext = { user, profile, syncOfflineActions };
        document.body.dataset.userRole = profile.role;
        window.pathfinderProfile = { user, profile };
        document.dispatchEvent(new CustomEvent("pathfinder:profile-ready", {
            detail: { user, profile }
        }));

        try {
            const syncResult = await syncOfflineActions(user, profile);
            if (sequence !== authStateSequence || auth.currentUser?.uid !== user.uid) return;
            if (syncResult.failed.length) {
                console.error("Some offline actions need attention before they can be synced.", syncResult.failed);
            }
        } catch (error) {
            if (sequence !== authStateSequence || auth.currentUser?.uid !== user.uid) return;
            console.error("Could not sync pending offline actions.", error);
            document.dispatchEvent(new CustomEvent("pathfinder:offline-sync-error", { detail: { error } }));
        }
    }
    const email = document.getElementById("account-email");
    if (email) email.textContent = user.email || "";
    const nameInput = document.getElementById("display-name");
    if (nameInput) nameInput.value = user.displayName || "";
}

function resolveAppPath(targetPage) {
    const path = window.location.pathname || "";
    const isInsideDotVscode = path.includes("/.vscode/") || path.endsWith("/.vscode");
    return isInsideDotVscode ? targetPage : `./${targetPage}`;
}

function profileLoadErrorMessage(error) {
    if (error?.code === "permission-denied") {
        return "Firestore denied access to your account profile. Confirm the deployed rules allow signed-in users to read and create their own users/{uid} profile.";
    }
    if (!navigator.onLine || ["unavailable", "network-request-failed"].includes(error?.code)) {
        return "Could not reach Firestore to verify your account profile. Check your connection and try again.";
    }
    return error?.message || "Could not verify your account profile. Check your Firestore configuration and rules.";
}

window.addEventListener("online", async () => {
    if (!offlineSyncContext) {
        if (auth.currentUser && document.querySelector("main[data-page], #event-form")) {
            await handleAuthState(auth.currentUser);
        }
        return;
    }
    try {
        const result = await offlineSyncContext.syncOfflineActions(
            offlineSyncContext.user,
            offlineSyncContext.profile
        );
        if (result.failed.length) {
            console.error("Some offline actions need attention before they can be synced.", result.failed);
        }
    } catch (error) {
        console.error("Could not sync pending offline actions.", error);
    }
});

function initialize() {
    setupLoginPage();
    setupSignupPage();
    setupForgotPasswordPage();
    setupResetPasswordPage();
    setupAccountPage();
    onAuthStateChanged(auth, handleAuthState, (error) => {
        authStateSequence += 1;
        offlineSyncContext = null;
        window.pathfinderAuthError = error;
        window.pathfinderProfileError = null;
        delete document.body.dataset.userRole;
        delete window.pathfinderProfile;
        const status = document.getElementById("login-status") ||
            document.getElementById("signup-message") ||
            document.getElementById("reset-message") ||
            document.getElementById("new-password-message");
        if (status) status.textContent = friendlyAuthError(error);
        if (document.querySelector("main[data-page], #event-form")) {
            document.dispatchEvent(new CustomEvent("pathfinder:auth-error", { detail: { error } }));
        }
    });
    setupSignoutPage();
}

initialize();
