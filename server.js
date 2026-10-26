require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const helmet = require("helmet");
const nodemailer = require("nodemailer");
const { createDatabase, SQLiteSessionStore } = require("./db");

const ROOT = __dirname;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_BYTES = 72;
const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const BCRYPT_ROUNDS = 12;
const PUBLIC_FILES = new Set([
    "/index.html",
    "/kiosks.html",
    "/components.html",
    "/log-event.html",
    "/fault-history.html",
    "/alerts.html",
    "/reports.html",
    "/users.html",
    "/roles.html",
    "/audit-log.html",
    "/account.html",
    "/admin-login.html",
    "/signup.html",
    "/forgot-password.html",
    "/reset-password.html",
    "/login.html",
    "/signout.html",
    "/.vscode/index.html",
    "/.vscode/login.html",
    "/.vscode/admin-login.html",
    "/.vscode/signup.html",
    "/.vscode/forgot-password.html",
    "/.vscode/reset-password.html",
    "/.vscode/signout.html",
    "/.vscode/account.html",
    "/.vscode/style.css",
    "/.vscode/auth-client.js",
    "/.vscode/signout-client.js",
    "/.vscode/app-shell.js",
    "/.vscode/font-loader.js",
    "/.vscode/data-page-client.js",
    "/.vscode/data-service.js",
    "/.vscode/event-client.js",
    "/.vscode/firebase-auth-client.js",
    "/.vscode/firebase-client.js",
    "/.vscode/firebase-config.js",
    "/.vscode/firebase-emulator.js",
    "/.vscode/page-config.js"
]);

function normalizeEmail(value) {
    return value.trim().toLowerCase();
}

function validEmail(value) {
    return value.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function passwordError(value) {
    const byteLength = Buffer.byteLength(value, "utf8");
    if (value.length < PASSWORD_MIN_LENGTH) {
        return "Password must contain at least 6 characters.";
    }
    if (byteLength > PASSWORD_MAX_BYTES) {
        return "Password is too long. Use no more than 72 UTF-8 bytes.";
    }
    return null;
}

function validName(value) {
    return typeof value === "string" &&
        value.trim().length >= 1 &&
        value.trim().length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function safeUser(user) {
    return { id: user.id, name: user.name, email: user.email };
}

function regenerateSession(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((error) => error ? reject(error) : resolve());
    });
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save((error) => error ? reject(error) : resolve());
    });
}

function createMailerFromEnvironment() {
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return null;

    return nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT || 587),
        secure: SMTP_SECURE === "true",
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
}

function createApp(options = {}) {
    const db = options.db || createDatabase();
    const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
    if (typeof sessionSecret !== "string" || sessionSecret.length < 32) {
        throw new Error("SESSION_SECRET must be set to at least 32 characters.");
    }

    const app = express();
    const isProduction = (options.nodeEnv || process.env.NODE_ENV) === "production";
    const appBaseUrl = new URL(options.appBaseUrl || process.env.APP_BASE_URL || "http://localhost:3000");
    if (isProduction && appBaseUrl.protocol !== "https:") {
        throw new Error("APP_BASE_URL must use HTTPS in production.");
    }

    if (process.env.TRUST_PROXY === "1" && options.trustProxy !== false) {
        app.set("trust proxy", 1);
    }

    const store = new SQLiteSessionStore(db);
    const cleanupTimer = setInterval(() => {
        try {
            store.cleanupExpired();
            db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL")
                .run(Date.now());
        } catch (error) {
            console.error("Authentication data cleanup failed:", error.message);
        }
    }, 60 * 60 * 1000);
    cleanupTimer.unref();

    const mailer = options.mailer === undefined ? createMailerFromEnvironment() : options.mailer;
    const sendResetEmail = options.sendResetEmail || (mailer && (async (email, resetUrl) => {
        await mailer.sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: "Reset your Pathfinder password",
            text: `Use this one-time link to reset your Pathfinder password. It expires in 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
            html: `<p>Use this one-time link to reset your Pathfinder password. It expires in 30 minutes:</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`
        });
    }));

    app.disable("x-powered-by");
    app.locals.db = db;
    app.locals.sessionStore = store;
    app.locals.cleanupTimer = cleanupTimer;

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "https://www.gstatic.com", "https://cdn.jsdelivr.net"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:"],
                connectSrc: [
                    "'self'",
                    "https://identitytoolkit.googleapis.com",
                    "https://securetoken.googleapis.com",
                    "https://firestore.googleapis.com",
                    "http://127.0.0.1:8080",
                    "http://127.0.0.1:9099"
                ],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"]
            }
        },
        crossOriginEmbedderPolicy: false
    }));
    app.use(express.json({ limit: "10kb", strict: true }));
    app.use(express.urlencoded({ extended: false, limit: "10kb" }));
    app.use((req, res, next) => {
        if (!req.body) req.body = {};
        next();
    });
    app.use(session({
        name: "pathfinder.sid",
        secret: sessionSecret,
        store,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            httpOnly: true,
            secure: isProduction,
            sameSite: "strict",
            maxAge: 8 * 60 * 60 * 1000,
            path: "/"
        }
    }));
    app.use("/api", (req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many attempts. Please wait and try again." }
    });
    const registrationLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: 5,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many registration attempts. Please try again later." }
    });
    const resetLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: 5,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many password reset requests. Please try again later." }
    });

    const requireCsrf = (req, res, next) => {
        const supplied = req.get("x-csrf-token") || "";
        const expected = req.session.csrfToken || "";
        const suppliedBuffer = Buffer.from(supplied);
        const expectedBuffer = Buffer.from(expected);
        if (
            suppliedBuffer.length === 0 ||
            suppliedBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
        ) {
            return res.status(403).json({ error: "Request expired. Refresh the page and try again." });
        }
        return next();
    };

    const requireAuth = (req, res, next) => {
        const sessionUser = req.session.user;
        if (!sessionUser) {
            return res.status(401).json({ error: "Please sign in to continue." });
        }

        const user = db.prepare(
            "SELECT id, name, email, auth_version FROM users WHERE id = ?"
        ).get(sessionUser.id);
        if (!user || user.auth_version !== sessionUser.authVersion) {
            return req.session.destroy(() => {
                res.clearCookie("pathfinder.sid", { path: "/" });
                res.status(401).json({ error: "Please sign in to continue." });
            });
        }

        req.user = user;
        return next();
    };

    app.get("/api/csrf", (req, res) => {
        if (!req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
        }
        return res.json({ csrfToken: req.session.csrfToken });
    });

    app.get("/api/me", requireAuth, (req, res) => {
        return res.json({ user: safeUser(req.user) });
    });

    app.post("/api/auth/register", registrationLimiter, requireCsrf, async (req, res, next) => {
        try {
            const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
            const email = typeof req.body.email === "string" ? normalizeEmail(req.body.email) : "";
            const password = typeof req.body.password === "string" ? req.body.password : "";
            if (!validName(name)) {
                return res.status(400).json({ error: "Enter a name between 1 and 100 characters." });
            }
            if (!validEmail(email)) {
                return res.status(400).json({ error: "Enter a valid email address." });
            }
            const passwordProblem = passwordError(password);
            if (passwordProblem) return res.status(400).json({ error: passwordProblem });

            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            let result;
            try {
                result = db.prepare(
                    "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
                ).run(name, email, passwordHash);
            } catch (error) {
                if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
                    return res.status(409).json({ error: "An account already exists for this email address." });
                }
                throw error;
            }

            const user = db.prepare(
                "SELECT id, name, email, auth_version FROM users WHERE id = ?"
            ).get(result.lastInsertRowid);
            await regenerateSession(req);
            req.session.user = { id: user.id, authVersion: user.auth_version };
            await saveSession(req);
            return res.status(201).json({ user: safeUser(user) });
        } catch (error) {
            return next(error);
        }
    });

    app.post("/api/auth/login", loginLimiter, requireCsrf, async (req, res, next) => {
        try {
            const email = typeof req.body.email === "string" ? normalizeEmail(req.body.email) : "";
            const password = typeof req.body.password === "string" ? req.body.password : "";
            if (!validEmail(email) || !password || Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
                return res.status(400).json({ error: "Email or password is incorrect." });
            }

            const user = db.prepare(
                "SELECT id, name, email, password_hash, auth_version FROM users WHERE email = ?"
            ).get(email);
            const matches = user
                ? await bcrypt.compare(password, user.password_hash)
                : (await bcrypt.hash(password, BCRYPT_ROUNDS), false);
            if (!user || !matches) {
                return res.status(401).json({ error: "Email or password is incorrect." });
            }

            await regenerateSession(req);
            req.session.user = { id: user.id, authVersion: user.auth_version };
            req.session.cookie.maxAge = req.body.remember === true
                ? 30 * 24 * 60 * 60 * 1000
                : 8 * 60 * 60 * 1000;
            await saveSession(req);
            return res.json({ user: safeUser(user) });
        } catch (error) {
            return next(error);
        }
    });

    app.post("/api/auth/logout", requireCsrf, (req, res, next) => {
        req.session.destroy((error) => {
            if (error) return next(error);
            res.clearCookie("pathfinder.sid", { path: "/" });
            return res.status(204).end();
        });
    });

    app.post("/api/auth/forgot-password", resetLimiter, requireCsrf, async (req, res, next) => {
        try {
            if (!sendResetEmail) {
                return res.status(503).json({ error: "Password reset email is not configured. Contact the site administrator." });
            }

            const email = typeof req.body.email === "string" ? normalizeEmail(req.body.email) : "";
            if (!validEmail(email)) {
                return res.status(400).json({ error: "Enter a valid email address." });
            }
            const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
            if (user) {
                const rawToken = crypto.randomBytes(32).toString("base64url");
                const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
                const expiresAt = Date.now() + RESET_TOKEN_LIFETIME_MS;
                db.prepare(`
                    UPDATE password_reset_tokens
                    SET used_at = ?
                    WHERE user_id = ? AND used_at IS NULL
                `).run(Date.now(), user.id);
                db.prepare(`
                    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
                    VALUES (?, ?, ?)
                `).run(user.id, tokenHash, expiresAt);

                const resetUrl = new URL("/.vscode/reset-password.html", appBaseUrl);
                resetUrl.searchParams.set("token", rawToken);
                await sendResetEmail(user.email, resetUrl.toString());
            }
            return res.json({
                message: "If an account exists for that email, a password reset link will be sent."
            });
        } catch (error) {
            return next(error);
        }
    });

    app.post("/api/auth/reset-password", resetLimiter, requireCsrf, async (req, res, next) => {
        try {
            const token = typeof req.body.token === "string" ? req.body.token : "";
            const password = typeof req.body.password === "string" ? req.body.password : "";
            if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
                return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
            }
            const passwordProblem = passwordError(password);
            if (passwordProblem) return res.status(400).json({ error: passwordProblem });

            const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
            const reset = db.prepare(`
                SELECT id, user_id FROM password_reset_tokens
                WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
            `).get(tokenHash, Date.now());
            if (!reset) {
                return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
            }

            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            const updateReset = db.transaction(() => {
                const result = db.prepare(`
                    UPDATE password_reset_tokens SET used_at = ?
                    WHERE id = ? AND used_at IS NULL AND expires_at > ?
                `).run(Date.now(), reset.id, Date.now());
                if (result.changes !== 1) return false;
                db.prepare(`
                    UPDATE users SET password_hash = ?, auth_version = auth_version + 1
                    WHERE id = ?
                `).run(passwordHash, reset.user_id);
                return true;
            });

            if (!updateReset()) {
                return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
            }
            return res.json({ message: "Your password has been reset. You can now sign in." });
        } catch (error) {
            return next(error);
        }
    });

    app.patch("/api/account/profile", requireCsrf, requireAuth, (req, res) => {
        const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
        if (!validName(name)) {
            return res.status(400).json({ error: "Enter a name between 1 and 100 characters." });
        }
        db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.user.id);
        return res.json({ user: { id: req.user.id, name, email: req.user.email } });
    });

    app.patch("/api/account/password", requireCsrf, requireAuth, async (req, res, next) => {
        try {
            const currentPassword = typeof req.body.currentPassword === "string"
                ? req.body.currentPassword
                : "";
            const newPassword = typeof req.body.newPassword === "string"
                ? req.body.newPassword
                : "";
            if (!currentPassword || Buffer.byteLength(currentPassword, "utf8") > PASSWORD_MAX_BYTES) {
                return res.status(400).json({ error: "Your current password is incorrect." });
            }
            const passwordProblem = passwordError(newPassword);
            if (passwordProblem) return res.status(400).json({ error: passwordProblem });

            const user = db.prepare(
                "SELECT password_hash FROM users WHERE id = ?"
            ).get(req.user.id);
            if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
                return res.status(401).json({ error: "Your current password is incorrect." });
            }

            const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
            const updated = db.prepare(`
                UPDATE users SET password_hash = ?, auth_version = auth_version + 1
                WHERE id = ? AND auth_version = ?
            `).run(passwordHash, req.user.id, req.session.user.authVersion);
            if (updated.changes !== 1) {
                return res.status(401).json({ error: "Your session expired. Sign in again." });
            }

            req.session.user.authVersion += 1;
            await saveSession(req);
            return res.json({ message: "Your password has been updated." });
        } catch (error) {
            return next(error);
        }
    });

    app.get("/", (req, res) => res.redirect("/.vscode/login.html"));

    app.get(/.*/, (req, res, next) => {
        if (!PUBLIC_FILES.has(req.path)) return next();
        const filePath = path.resolve(ROOT, `.${req.path}`);
        if (!filePath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filePath)) {
            return res.sendStatus(404);
        }
        return res.sendFile(filePath, { dotfiles: "allow" });
    });

    app.use((req, res) => res.status(404).json({ error: "Not found." }));

    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
            return res.status(400).json({ error: "Request body must be valid JSON." });
        }
        console.error("Request failed:", error.message);
        return res.status(500).json({ error: "Something went wrong. Please try again." });
    });

    return app;
}

if (require.main === module) {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32 || secret === "replace_with_a_random_secret_at_least_32_characters") {
        console.error("Set SESSION_SECRET in your .env file to a private random value of at least 32 characters.");
        process.exitCode = 1;
    } else {
        const app = createApp();
        const port = Number(process.env.PORT || 3000);
        app.listen(port, () => {
            console.log(`Pathfinder is running at http://localhost:${port}`);
        });
    }
}

module.exports = { createApp, passwordError, validEmail, validName };
