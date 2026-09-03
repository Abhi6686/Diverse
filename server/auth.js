/* auth.js - who is asking, and what they are allowed to do.
 *
 * Passwords are hashed with scrypt and a per-user salt. scrypt is deliberately
 * slow and memory-hard, which is the whole point: it is what stops a stolen
 * diverse.db from being turned into a list of everyone's passwords overnight.
 * It is in Node's own crypto module, so this costs no dependency.
 *
 * Sessions are a random token with a row in the database, not a signed token
 * carried by the browser. That choice buys two things the office needs: logging
 * out genuinely revokes, and deactivating somebody takes effect on their next
 * request rather than whenever a token would have expired.
 *
 * Everything here is synchronous, like the rest of server/db.js. scryptSync at
 * these parameters is ~60ms, which happens on login and on nothing else.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const perms = require('./permissions');

const COOKIE = 'dvsid';
const SESSION_DAYS = 30;
const KEYLEN = 64;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/* Thrown by the guards below; api.js turns it into the status it carries. */
class AuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code || null;
  }
}

function handle() { return db.handle(); }
function now() { return new Date().toISOString(); }

/* ---- passwords --------------------------------------------------------- */

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, KEYLEN, SCRYPT).toString('hex');
  return { hash, salt: s };
}

/* timingSafeEqual rather than ===: a plain comparison returns faster the sooner
   it finds a difference, which over enough attempts leaks the hash. */
function verifyPassword(password, hash, salt) {
  let attempt;
  try { attempt = hashPassword(password, salt).hash; } catch (e) { return false; }
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* A password that is only long enough to be typed quickly is the weakest link
   in all of this, so the rule is stated once and applied everywhere. */
function checkPasswordStrength(password) {
  const p = String(password == null ? '' : password);
  if (p.length < 8) {
    throw new AuthError(400, 'A password needs at least 8 characters.');
  }
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) {
    throw new AuthError(400, 'A password needs at least one letter and one number.');
  }
  return p;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkEmail(email) {
  const e = String(email == null ? '' : email).trim().toLowerCase();
  if (!EMAIL.test(e)) throw new AuthError(400, 'That does not look like an email address.');
  return e;
}

/* ---- roles ------------------------------------------------------------- */

/* Through clean() so the answer is always in catalogue order and never names a
   permission this build has since dropped - a role stored by an older version
   must not smuggle one back in. */
function permsOfRole(roleId) {
  return perms.clean(handle().prepare('SELECT perm FROM role_permissions WHERE role_id = ?')
    .all(Number(roleId)).map(r => r.perm));
}

function roleRow(id) {
  return handle().prepare('SELECT id, name, builtin FROM roles WHERE id = ?').get(Number(id));
}

function roleByName(name) {
  return handle().prepare('SELECT id, name, builtin FROM roles WHERE name = ?').get(String(name));
}

function listRoles() {
  return handle().prepare('SELECT id, name, builtin FROM roles ORDER BY builtin DESC, name').all()
    .map(r => Object.assign({}, r, {
      builtin: !!r.builtin,
      permissions: permsOfRole(r.id),
      // What a role screen has to show before offering Delete.
      users: handle().prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(r.id).n
    }));
}

function setRolePermissions(roleId, list) {
  const wanted = perms.clean(list);
  db.tx(() => {
    handle().prepare('DELETE FROM role_permissions WHERE role_id = ?').run(Number(roleId));
    const ins = handle().prepare('INSERT INTO role_permissions (role_id, perm) VALUES (?, ?)');
    for (const p of wanted) ins.run(Number(roleId), p);
  });
  return wanted;
}

function createRole(name, list) {
  const clean = String(name || '').trim();
  if (!clean) throw new AuthError(400, 'A role needs a name.');
  if (roleByName(clean)) throw new AuthError(409, '"' + clean + '" is already a role.');
  const info = handle().prepare(
    'INSERT INTO roles (name, builtin, created_at) VALUES (?, 0, ?)').run(clean, now());
  const id = Number(info.lastInsertRowid);
  setRolePermissions(id, list || []);
  return roleRow(id);
}

function updateRole(roleId, patch, actor) {
  const role = roleRow(roleId);
  if (!role) throw new AuthError(404, 'No such role.');

  if (patch.name !== undefined && !role.builtin) {
    const clean = String(patch.name || '').trim();
    if (!clean) throw new AuthError(400, 'A role needs a name.');
    const clash = roleByName(clean);
    if (clash && clash.id !== role.id) throw new AuthError(409, '"' + clean + '" is already a role.');
    handle().prepare('UPDATE roles SET name = ? WHERE id = ?').run(clean, role.id);
  }

  if (patch.permissions !== undefined) {
    const wanted = perms.clean(patch.permissions);

    /* Locking yourself out is the one mistake this screen makes easy and that
       nobody can undo from inside the app. Taking admin.roles off your own role
       means you can never put it back. */
    if (actor && actor.roleId === role.id && wanted.indexOf('admin.roles') < 0) {
      throw new AuthError(409,
        'That would remove your own ability to manage roles, and nobody could put it back. ' +
        'Change it from another Admin account, or leave admin.roles on this role.');
    }
    // The same argument for the people screen: an estate with no account that
    // can create users cannot ever add one.
    if (wanted.indexOf('admin.users') < 0 && lastRoleWith('admin.users', role.id)) {
      throw new AuthError(409,
        'This is the only role that can manage people. Give another role that ' +
        'permission first.');
    }
    setRolePermissions(role.id, wanted);
  }

  return Object.assign({}, roleRow(role.id), { permissions: permsOfRole(role.id) });
}

/* True when `roleId` is the only role holding `perm` that anybody is actually
   in - a role nobody uses cannot lock the estate out of anything. */
function lastRoleWith(perm, roleId) {
  const rows = handle().prepare(
    'SELECT DISTINCT u.role_id AS id FROM users u ' +
    ' JOIN role_permissions rp ON rp.role_id = u.role_id ' +
    ' WHERE rp.perm = ? AND u.active = 1').all(perm);
  return rows.length === 1 && rows[0].id === Number(roleId);
}

function deleteRole(roleId) {
  const role = roleRow(roleId);
  if (!role) throw new AuthError(404, 'No such role.');
  if (role.builtin) throw new AuthError(409, '"' + role.name + '" is built in and cannot be deleted.');
  const inUse = handle().prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(role.id).n;
  if (inUse) {
    throw new AuthError(409, inUse + ' ' + (inUse === 1 ? 'person is' : 'people are') +
      ' in "' + role.name + '". Move them to another role first.');
  }
  handle().prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  return true;
}

/* ---- users ------------------------------------------------------------- */

/* Never includes pw_hash or pw_salt. This is the shape that goes over the wire
   and onto the screen, so the hash cannot leak by somebody adding a field to a
   response later. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, name: row.name,
    initials: row.initials || '', roleId: row.role_id,
    role: row.role_name || (roleRow(row.role_id) || {}).name || '',
    active: !!row.active,
    createdAt: row.created_at, lastSeenAt: row.last_seen_at
  };
}

const USER_SELECT =
  'SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id ';

function userById(id) {
  return handle().prepare(USER_SELECT + 'WHERE u.id = ?').get(Number(id));
}

function userByEmail(email) {
  return handle().prepare(USER_SELECT + 'WHERE u.email = ?').get(String(email).trim().toLowerCase());
}

function listUsers() {
  return handle().prepare(USER_SELECT + 'ORDER BY u.active DESC, u.name').all().map(publicUser);
}

function anyUsers() {
  return handle().prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

/* How many people could still administer the place if this one went away. The
   guard behind "you cannot delete, demote or deactivate the last Admin". */
function otherAdmins(excludeUserId) {
  return handle().prepare(
    'SELECT COUNT(*) AS n FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id ' +
    ' WHERE rp.perm = ? AND u.active = 1 AND u.id <> ?')
    .get('admin.users', Number(excludeUserId || 0)).n;
}

function assertNotLastAdmin(userId, what) {
  const u = userById(userId);
  if (!u) return;
  if (permsOfRole(u.role_id).indexOf('admin.users') < 0) return;   // not an admin anyway
  if (!u.active) return;
  if (otherAdmins(userId) > 0) return;
  throw new AuthError(409,
    u.name + ' is the only active account that can manage people, so they cannot be ' +
    what + '. Create another Admin first.');
}

function createUser(input) {
  const email = checkEmail(input.email);
  const name = String(input.name || '').trim();
  if (!name) throw new AuthError(400, 'A person needs a name.');
  if (userByEmail(email)) throw new AuthError(409, email + ' already has an account.');

  const role = input.roleId ? roleRow(input.roleId) : roleByName('Employee');
  if (!role) throw new AuthError(400, 'No such role.');

  const password = checkPasswordStrength(input.password);
  const pw = hashPassword(password);
  const initials = String(input.initials || '').trim().toUpperCase();

  const info = handle().prepare(
    'INSERT INTO users (email, name, initials, role_id, pw_hash, pw_salt, active, created_at) ' +
    'VALUES (?,?,?,?,?,?,?,?)')
    .run(email, name, initials || null, role.id, pw.hash, pw.salt,
      input.active === false ? 0 : 1, now());

  return publicUser(userById(Number(info.lastInsertRowid)));
}

function updateUser(userId, patch, actor) {
  const u = userById(userId);
  if (!u) throw new AuthError(404, 'No such person.');

  if (patch.email !== undefined) {
    const email = checkEmail(patch.email);
    const clash = userByEmail(email);
    if (clash && clash.id !== u.id) throw new AuthError(409, email + ' already has an account.');
    handle().prepare('UPDATE users SET email = ? WHERE id = ?').run(email, u.id);
  }
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new AuthError(400, 'A person needs a name.');
    handle().prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
  }
  if (patch.initials !== undefined) {
    handle().prepare('UPDATE users SET initials = ? WHERE id = ?')
      .run(String(patch.initials || '').trim().toUpperCase() || null, u.id);
  }
  if (patch.roleId !== undefined && Number(patch.roleId) !== u.role_id) {
    const role = roleRow(patch.roleId);
    if (!role) throw new AuthError(400, 'No such role.');
    if (perms.clean(permsOfRole(role.id)).indexOf('admin.users') < 0) {
      assertNotLastAdmin(u.id, 'moved out of Admin');
    }
    handle().prepare('UPDATE users SET role_id = ? WHERE id = ?').run(role.id, u.id);
  }
  if (patch.active !== undefined) {
    const active = patch.active ? 1 : 0;
    if (!active) {
      if (actor && actor.id === u.id) {
        throw new AuthError(409, 'You cannot deactivate your own account.');
      }
      assertNotLastAdmin(u.id, 'deactivated');
      // Turning somebody off has to take effect now, not when their session
      // would have expired on its own.
      revokeAllFor(u.id);
    }
    handle().prepare('UPDATE users SET active = ? WHERE id = ?').run(active, u.id);
  }
  if (patch.password !== undefined && patch.password !== '') {
    const pw = hashPassword(checkPasswordStrength(patch.password));
    handle().prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?')
      .run(pw.hash, pw.salt, u.id);
    // Every other machine they were signed in on is now signed out; a password
    // change that leaves old sessions alive has not changed anything.
    revokeAllFor(u.id, patch.keepSession || null);
  }

  return publicUser(userById(u.id));
}

function deleteUser(userId, actor) {
  const u = userById(userId);
  if (!u) throw new AuthError(404, 'No such person.');
  if (actor && actor.id === u.id) throw new AuthError(409, 'You cannot delete your own account.');
  assertNotLastAdmin(u.id, 'deleted');
  handle().prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return true;
}

/* The very first account. Only possible while there are none - otherwise this
   route would be a way to mint an Admin without being one. */
function setupFirstAdmin(input) {
  if (anyUsers()) throw new AuthError(409, 'This database already has accounts. Sign in instead.');
  const admin = roleByName('Admin');
  return createUser(Object.assign({}, input, { roleId: admin.id, active: true }));
}

/* ---- sessions ---------------------------------------------------------- */

function newToken() { return crypto.randomBytes(32).toString('hex'); }

function startSession(userId) {
  const token = newToken();
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86400000);
  handle().prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, seen_at) VALUES (?,?,?,?,?)')
    .run(token, Number(userId), created.toISOString(), expires.toISOString(), created.toISOString());
  return { token, expires };
}

function revoke(token) {
  if (!token) return;
  handle().prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
}

function revokeAllFor(userId, keepToken) {
  if (keepToken) {
    handle().prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
      .run(Number(userId), String(keepToken));
  } else {
    handle().prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
  }
}

/* Expired rows are deleted rather than ignored, so the table does not grow
   forever on a machine that runs for a year. */
function sweep() {
  handle().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

function login(email, password) {
  const row = userByEmail(String(email || ''));
  // The same message either way. "No such account" tells anyone who asks which
  // addresses have accounts here.
  const wrong = new AuthError(401, 'That email address and password do not match.');
  if (!row) {
    // Still spend the time, so a missing account cannot be told from a wrong
    // password by how quickly the answer comes back.
    hashPassword(String(password || ''), 'timing');
    throw wrong;
  }
  if (!verifyPassword(String(password || ''), row.pw_hash, row.pw_salt)) throw wrong;
  if (!row.active) {
    throw new AuthError(403, 'This account has been deactivated. Ask an administrator.');
  }
  handle().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
  sweep();
  return { user: sessionUser(row), session: startSession(row.id) };
}

/* The user object every request is answered in the context of. Carries the
   resolved permission list so nothing downstream has to query again. */
function sessionUser(row) {
  return {
    id: row.id, email: row.email, name: row.name,
    initials: row.initials || '',
    roleId: row.role_id, role: row.role_name || (roleRow(row.role_id) || {}).name || '',
    permissions: permsOfRole(row.role_id)
  };
}

function cookieToken(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/* Who is making this request, or null. Checks the session is not expired and
   that the account behind it is still active - a deactivated person holding a
   valid cookie is not signed in. */
function currentUser(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const s = handle().prepare('SELECT token, user_id, expires_at FROM sessions WHERE token = ?')
    .get(token);
  if (!s) return null;
  if (s.expires_at < now()) { revoke(token); return null; }

  const row = userById(s.user_id);
  if (!row || !row.active) { revoke(token); return null; }

  // Sliding expiry, written at most once an hour so an active session does not
  // mean a database write on every keystroke's worth of traffic.
  if (!s.seen_at || Date.now() - Date.parse(s.seen_at) > 3600000) {
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    handle().prepare('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE token = ?')
      .run(now(), expires, token);
    handle().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
  }

  const u = sessionUser(row);
  u.token = token;
  return u;
}

function cookieHeader(token, expires) {
  // Secure is deliberately not set: this runs on the office LAN over plain
  // http, and a Secure cookie would simply never be sent. SameSite=Lax and
  // HttpOnly are the two that matter here - script cannot read it, and another
  // site cannot make the browser use it.
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    Math.floor((expires.getTime() - Date.now()) / 1000);
}

function clearedCookieHeader() {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* ---- guards ------------------------------------------------------------ */

function require_(user, perm) {
  if (!user) throw new AuthError(401, 'Sign in first.', 'nosession');
  if (user.permissions.indexOf(perm) < 0) {
    throw new AuthError(403, 'Your role does not allow this (' + perm + ').', 'forbidden');
  }
  return true;
}

function can(user, perm) {
  return !!(user && user.permissions.indexOf(perm) >= 0);
}

module.exports = {
  AuthError, COOKIE,
  hashPassword, verifyPassword, checkPasswordStrength, checkEmail,
  listRoles, roleRow, roleByName, permsOfRole, createRole, updateRole, deleteRole,
  setRolePermissions, lastRoleWith,
  listUsers, userById, userByEmail, publicUser, anyUsers, otherAdmins,
  createUser, updateUser, deleteUser, setupFirstAdmin,
  login, startSession, revoke, revokeAllFor, sweep,
  currentUser, cookieToken, cookieHeader, clearedCookieHeader,
  require: require_, can
};
