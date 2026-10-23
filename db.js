const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const session = require("express-session");

function createDatabase(databasePath = process.env.DATABASE_PATH || "./data/pathfinder.sqlite") {
    const resolvedPath = databasePath === ":memory:"
        ? databasePath
        : path.resolve(databasePath);

    if (resolvedPath !== ":memory:") {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            auth_version INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at INTEGER NOT NULL,
            used_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
            ON password_reset_tokens(expires_at);
    `);

    return db;
}

class SQLiteSessionStore extends session.Store {
    constructor(db) {
        super();
        this.db = db;
        this.getSession = db.prepare(
            "SELECT data, expires_at FROM sessions WHERE sid = ?"
        );
        this.upsertSession = db.prepare(`
            INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
        `);
        this.deleteSession = db.prepare("DELETE FROM sessions WHERE sid = ?");
        this.deleteExpiredSessions = db.prepare(
            "DELETE FROM sessions WHERE expires_at <= ?"
        );
    }

    get(sid, callback) {
        try {
            const row = this.getSession.get(sid);
            if (!row) return callback(null, null);
            if (row.expires_at <= Date.now()) {
                this.deleteSession.run(sid);
                return callback(null, null);
            }
            return callback(null, JSON.parse(row.data));
        } catch (error) {
            return callback(error);
        }
    }

    set(sid, sessionData, callback = () => {}) {
        try {
            const cookieExpiry = sessionData.cookie?.expires
                ? new Date(sessionData.cookie.expires).getTime()
                : Date.now() + (sessionData.cookie?.maxAge || 24 * 60 * 60 * 1000);
            this.upsertSession.run(sid, JSON.stringify(sessionData), cookieExpiry);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    touch(sid, sessionData, callback = () => {}) {
        this.set(sid, sessionData, callback);
    }

    destroy(sid, callback = () => {}) {
        try {
            this.deleteSession.run(sid);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    cleanupExpired() {
        this.deleteExpiredSessions.run(Date.now());
    }
}

module.exports = { createDatabase, SQLiteSessionStore };
