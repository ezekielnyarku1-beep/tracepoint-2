const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const { createApp } = require("../server");
const { createDatabase } = require("../db");

const db = createDatabase(":memory:");
const resetEmails = [];
const app = createApp({
    db,
    sessionSecret: "test-session-secret-that-is-long-enough-for-testing",
    appBaseUrl: "http://localhost:3000",
    sendResetEmail: async (email, url) => resetEmails.push({ email, url })
});
const browser = request.agent(app);
let csrfToken;
let userId;
let server;

before(async () => {
    server = app.listen(0);
    csrfToken = (await browser.get("/api/csrf").expect(200)).body.csrfToken;
});

after(async () => {
    clearInterval(app.locals.cleanupTimer);
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    db.close();
});

test("registration validates input and stores only a bcrypt hash", async () => {
    const response = await browser.post("/api/auth/register")
        .set("X-CSRF-Token", csrfToken)
        .send({ name: "  Pathfinder User  ", email: "USER@example.com", password: "StrongPass123" })
        .expect(201);
    assert.equal(response.body.user.name, "Pathfinder User");
    assert.equal(response.body.user.email, "user@example.com");
    userId = response.body.user.id;
    assert.match(response.headers["set-cookie"].join(";"), /HttpOnly/i);
    assert.match(response.headers["set-cookie"].join(";"), /SameSite=Strict/i);

    const storedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    assert.notEqual(storedUser.password_hash, "StrongPass123");
    assert.match(storedUser.password_hash, /^\$2[aby]\$/);
    assert.equal(await bcrypt.compare("StrongPass123", storedUser.password_hash), true);
    await browser.get("/api/me").expect(200);
    csrfToken = (await browser.get("/api/csrf").expect(200)).body.csrfToken;
});

test("state-changing requests require the session CSRF token", async () => {
    await browser.post("/api/auth/logout")
        .set("X-CSRF-Token", "not-the-session-token")
        .expect(403);
});

test("login rejects invalid credentials and logout clears the session", async () => {
    const invalidBrowser = request.agent(app);
    const invalidToken = (await invalidBrowser.get("/api/csrf").expect(200)).body.csrfToken;
    await invalidBrowser.post("/api/auth/login")
        .set("X-CSRF-Token", invalidToken)
        .send({ email: "user@example.com", password: "wrong-password" })
        .expect(401)
        .expect(({ body }) => assert.equal(body.error, "Email or password is incorrect."));

    await browser.post("/api/auth/logout")
        .set("X-CSRF-Token", csrfToken)
        .expect(204);
    await browser.get("/api/me").expect(401);
});

test("reset links are one-time, expire by policy, and change the password", async () => {
    const resetBrowser = request.agent(app);
    const resetCsrf = (await resetBrowser.get("/api/csrf").expect(200)).body.csrfToken;
    await resetBrowser.post("/api/auth/forgot-password")
        .set("X-CSRF-Token", resetCsrf)
        .send({ email: "user@example.com" })
        .expect(200);
    assert.equal(resetEmails.length, 1);

    const resetUrl = new URL(resetEmails[0].url);
    const token = resetUrl.searchParams.get("token");
    assert.ok(token);
    const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
    assert.notEqual(token, db.prepare(
        "SELECT token_hash FROM password_reset_tokens WHERE user_id = ?"
    ).get(userId).token_hash);

    const resetCsrfAfterRequest = resetCsrf;
    await resetBrowser.post("/api/auth/reset-password")
        .set("X-CSRF-Token", resetCsrfAfterRequest)
        .send({ token, password: "NewSecurePass123" })
        .expect(200);
    assert.equal(db.prepare(
        "SELECT used_at FROM password_reset_tokens WHERE token_hash = ?"
    ).get(tokenHash).used_at !== null, true);
    await resetBrowser.post("/api/auth/reset-password")
        .set("X-CSRF-Token", resetCsrfAfterRequest)
        .send({ token, password: "AnotherPass123" })
        .expect(400);
});

test("account profile and password changes require authentication", async () => {
    const authenticatedBrowser = request.agent(app);
    const token = (await authenticatedBrowser.get("/api/csrf").expect(200)).body.csrfToken;
    await authenticatedBrowser.post("/api/auth/login")
        .set("X-CSRF-Token", token)
        .send({ email: "user@example.com", password: "NewSecurePass123", remember: true })
        .expect(200);
    const authenticatedCsrf = (await authenticatedBrowser.get("/api/csrf").expect(200)).body.csrfToken;

    await authenticatedBrowser.patch("/api/account/profile")
        .set("X-CSRF-Token", authenticatedCsrf)
        .send({ name: "Updated Name" })
        .expect(200)
        .expect(({ body }) => assert.equal(body.user.name, "Updated Name"));

    await authenticatedBrowser.patch("/api/account/password")
        .set("X-CSRF-Token", authenticatedCsrf)
        .send({ currentPassword: "NewSecurePass123", newPassword: "ChangedPass123" })
        .expect(200);
    await authenticatedBrowser.post("/api/auth/logout")
        .set("X-CSRF-Token", authenticatedCsrf)
        .expect(204);
});

test("static server does not expose server source or environment files", async () => {
    await request(app).get("/")
        .expect(302)
        .expect("Location", "/.vscode/login.html");
    await request(app).get("/server.js").expect(404);
    await request(app).get("/.env").expect(404);
    await request(app).get("/.vscode/login.html").expect(200);
    await request(app).get("/.vscode/admin-login.html").expect(200);
});
