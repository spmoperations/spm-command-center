// Task logins: someone on the team list, such as an editor, signs in to see the tickets given
// to them and nothing else. Not a Command Center of their own (that is a team login, team.ts):
// they have no inbox, no connections and no checks, and every other page and API refuses them
// (see proxy.ts and `ownerOfSession`).
//
// They sign in on the same login page: with Google, when their email is a Google account such
// as a Social Profit Media one (google-sign-in.ts), or with that email and a password the owner
// gave them. Only the owner gives, changes and takes away these logins, on the team list.
import crypto from "node:crypto";
import type { TaskLoginInfo } from "@/core/types";
import type { Db } from "./db";
import { isEmailAddress } from "./gmail";
import { OWNER_ID } from "./owner";
import type { Session } from "./session";
import { hashPassword, MIN_PASSWORD, passwordMark, passwordMatches } from "./team";
import { TEAM } from "./tickets";

/** Someone on the team list, signed in with their task login. */
export interface Member {
  id: string;
  name: string;
  email: string;
}

interface LoginRow {
  member_id: string;
  email: string;
  password_hash: string | null;
  since: number;
  name: string;
}

const loginFor = async (db: Db, email: string) =>
  (
    await db.query<LoginRow>(
      "select l.member_id, l.email, l.password_hash, l.since, m.name from task_logins l join team_members m on m.id = l.member_id where m.owner_id = $1 and lower(l.email) = lower($2)",
      [TEAM, email.trim()],
    )
  )[0] ?? null;

const asMember = (l: LoginRow): Member => ({ id: l.member_id, name: l.name, email: l.email });

/**
 * A mark of the login a session was made with. A new email or password, or a login taken away
 * and given again, ends every session made before.
 */
const markOf = (l: LoginRow) => passwordMark([l.member_id, l.email.toLowerCase(), l.password_hash ?? "", Number(l.since)].join("\n"));

/** Checked when the email has no password here, so a wrong email takes as long as a wrong password. */
const NOBODY = hashPassword(crypto.randomBytes(16).toString("hex"));

/** Who an email and password sign in as, among the task logins, or null. A login for Google only has no password, and never matches one. */
export async function memberByPassword(db: Db, email: string, password: string): Promise<{ member: Member; mark: string } | null> {
  const login = await loginFor(db, email);
  if (!passwordMatches(password, login?.password_hash ?? NOBODY) || !login?.password_hash) return null;
  return { member: asMember(login), mark: markOf(login) };
}

/** Who a Google account signs in as, once Google has said the address is theirs, or null. */
export async function memberByGoogle(db: Db, email: string): Promise<{ member: Member; mark: string } | null> {
  const login = await loginFor(db, email);
  return login ? { member: asMember(login), mark: markOf(login) } : null;
}

/** When they last signed in, for the owner's list. */
export const signedInNow = (db: Db, memberId: string, now: number) => db.run("update task_logins set last_in = $2 where member_id = $1", [memberId, now]);

/** The person a task login's session is for, or null when that login was changed or taken away since. */
export async function memberOfSession(db: Db, session: Session | null): Promise<Member | null> {
  if (!session?.member || !session.mark) return null;
  const login = await loginFor(db, session.email);
  return login && markOf(login) === session.mark ? asMember(login) : null;
}

/** The task logins by person on the team list, for the owner's Settings. Never a password. */
export async function taskLogins(db: Db): Promise<Map<string, TaskLoginInfo>> {
  const rows = await db.query<{ member_id: string; email: string; password: boolean; last_in: number | null }>(
    "select member_id, email, password_hash is not null as password, last_in from task_logins where owner_id = $1",
    [TEAM],
  );
  return new Map(rows.map((r) => [r.member_id, { email: r.email, password: r.password, lastIn: r.last_in == null ? null : Number(r.last_in) }]));
}

/** Why this email cannot be someone's task login: it is already how the owner, a team login or another person signs in. Null when it is free. */
export async function emailInUse(db: Db, email: string, memberId: string | null = null): Promise<string | null> {
  if (email === (process.env.LOGIN_EMAIL ?? "").trim().toLowerCase()) return "That is your own login.";
  const [user] = await db.query<{ id: string }>("select id from users where lower(login_email) = $1", [email]);
  const [other] = await db.query<{ member_id: string }>("select member_id from task_logins where lower(email) = $1 and member_id <> coalesce($2, '')", [email, memberId]);
  return user || other ? "Someone already signs in with that email." : null;
}

type Ctx = { db: Db; ownerId: string; now: Date };

function onlyOwner(c: Ctx): void {
  if (c.ownerId !== OWNER_ID) throw new Error("Only the owner can change who signs in.");
}

// Each action is one change the owner makes on screen, as in repo.ts. They are added to its ACTIONS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TASK_LOGIN_ACTIONS: Record<string, (c: Ctx, ...args: any[]) => Promise<void>> = {
  /**
   * Lets someone on the team list sign in to see their tasks, or changes how. An empty password
   * means Google only. Every session made with the login before ends.
   */
  async setTaskLogin(c, memberId: string, email: unknown, password: unknown) {
    onlyOwner(c);
    const address = String(email ?? "").trim().toLowerCase();
    const secret = String(password ?? "");
    if (!isEmailAddress(address)) throw new Error("That email address does not look right.");
    if (secret && secret.length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters, or none for Google only.`);
    const [person] = await c.db.query<{ id: string }>("select id from team_members where owner_id = $1 and id = $2", [TEAM, memberId]);
    if (!person) throw new Error("That person is no longer on the team list.");
    const taken = await emailInUse(c.db, address, memberId);
    if (taken) throw new Error(taken);
    await c.db.run(
      `insert into task_logins (member_id, owner_id, email, password_hash, since) values ($1, $2, $3, $4, $5)
       on conflict (member_id) do update set email = excluded.email, password_hash = excluded.password_hash, since = excluded.since`,
      [memberId, TEAM, address, secret ? hashPassword(secret) : null, c.now.getTime()],
    );
  },
  /** They can no longer sign in. Their tickets stay on the board. */
  async removeTaskLogin(c, memberId: string) {
    onlyOwner(c);
    await c.db.run("delete from task_logins where owner_id = $1 and member_id = $2", [TEAM, memberId]);
  },
};
