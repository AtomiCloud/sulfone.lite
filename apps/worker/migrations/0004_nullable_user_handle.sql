CREATE TABLE users_nullable_handle (id TEXT PRIMARY KEY, handle TEXT UNIQUE, login TEXT, admin INTEGER NOT NULL DEFAULT 0);
INSERT INTO users_nullable_handle (id, handle, login, admin) SELECT id, handle, login, admin FROM users;
DROP TABLE users;
ALTER TABLE users_nullable_handle RENAME TO users;
