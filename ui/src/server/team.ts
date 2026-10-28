// Team members: people with a Command Center of their own beside the owner's, such as Alex.
//
// The owner signs in with LOGIN_EMAIL and LOGIN_PASSWORD, exactly as before, and nothing of
// theirs changes. A team member's login is a row in `users`: their email and a hash of their
// password (scrypt, salted). Only the owner adds, changes and turns off these logins.
//
// Each person sees only their own rows: every query is limited to the signed-in person's id.
import crypto from "node:crypto";
import type { TeamLogin } from "@/core/types";
import type { Db } from "./db";
import { OWNER_ID } from "./owner";
import { checkLogin, loginConfigured, type Session } from "./session";

/** The shortest password a team member may be given. */
export const MIN_PASSWORD = 10;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/** A password, made into something that can be checked but not read back. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const given = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Checked when nobody has the email given, so a wrong email takes as long as a wrong password. */
const NOBODY = hashPassword(crypto.randomBytes(16).toString("hex"));

/**
 * A short mark of the password a team member's session was made with. Their session carries
 * it, so a new password or a login turned off ends every session made before.
 */
export const passwordMark = (stored: string) => crypto.createHash("sha256").update(stored).digest("base64url").slice(0, 16);

interface Login {
  id: string;
  password_hash: string;
}

const findLogin = async (db: Db, email: string) =>
  (await db.query<Login>("select id, password_hash from users where lower(login_email) = lower($1) and password_hash is not null", [email.trim()]))[0] ?? null;

/** The database, opened only when a team member's login has to be looked up. */
type Opener = () => Promise<Db>;

/**
 * Who an email and password sign in as: the owner (LOGIN_EMAIL and LOGIN_PASSWORD), a team
 * member, or nobody. `mark` goes in a team member's session (see passwordMark). The owner's
 * login is checked first and needs no database, as before.
 */
export async function signInAs(open: Opener, email: string, password: string): Promise<{ ownerId: string; mark?: string } | null> {
  if (checkLogin(email, password)) return { ownerId: OWNER_ID };
  const login = await findLogin(await open(), email);
  if (!passwordMatches(password, login?.password_hash ?? NOBODY) || !login) return null;
  return { ownerId: login.id, mark: passwordMark(login.password_hash) };
}

/**
 * Whose data a session reads and changes, or null when it no longer belongs to anyone.
 * The owner's session is the one made with LOGIN_EMAIL, as it always was, and needs no
 * database: signing in once still lasts its week.
 */
export async function ownerOfSession(open: Opener, session: Session): Promise<string | null> {
  // A task login sees its own tickets on /my-tasks and nothing else (see task-logins.ts).
  if (session.member) return null;
  if (!session.mark) return loginConfigured() && session.email.trim().toLowerCase() === process.env.LOGIN_EMAIL!.trim().toLowerCase() ? OWNER_ID : null;
  const login = await findLogin(await open(), session.email);
  if (!login || passwordMark(login.password_hash) !== session.mark) return null;
  return login.id;
}

/** The team members' logins, for the owner's Settings. */
export async function teamLogins(db: Db): Promise<TeamLogin[]> {
  const rows = await db.query<{ id: string; name: string; login_email: string; password_hash: string | null; created_at: number }>(
    "select id, name, login_email, password_hash, created_at from users where login_email is not null order by created_at",
  );
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.login_email, active: r.password_hash !== null, createdAt: Number(r.created_at) }));
}

/** Everyone whose checks run on the schedule: the owner first, then each team member who can sign in. */
export async function scheduledOwners(db: Db): Promise<string[]> {
  const rows = await db.query<{ id: string }>("select id from users where id <> $1 and login_email is not null and password_hash is not null order by created_at", [OWNER_ID]);
  return [OWNER_ID, ...rows.map((r) => r.id)];
}
