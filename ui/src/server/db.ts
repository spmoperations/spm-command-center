// Database access. Two homes, one schema:
//   * With DATABASE_URL set, the hosted Postgres (Supabase).
//   * Without it, PGlite: a real Postgres engine that runs inside the server and keeps its
//     files in `.data/pg`. Handy for development and what the tests use.
// The migrations in `db/migrations` are plain Postgres and apply to both.
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs a statement and returns how many rows it changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
}

function wrap(q: Queryable, transaction: Db["transaction"], close: Db["close"]): Db {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows as T[],
    run: async (sql, params = []) => (await q.query(sql, params)).affectedRows ?? 0,
    transaction,
    close,
  };
}

const FIRST_SCHEMA = "0001_init.sql";

/** Applies every migration file in `db/migrations` that has not run yet, in name order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.run("create table if not exists schema_migrations (name text primary key, applied_at bigint not null)");
  // Locked like every other table (see 0002). Done here because the app creates this one.
  await db.run("alter table schema_migrations enable row level security");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  if (done.size === 0) {
    // The first schema may have been run by hand in the SQL editor. If its tables are there
    // already, record it as applied instead of failing on "table already exists".
    const [{ present }] = await db.query<{ present: boolean }>("select to_regclass('public.users') is not null as present");
    if (present) {
      await db.run("insert into schema_migrations (name, applied_at) values ($1, $2)", [FIRST_SCHEMA, Date.now()]);
      done.add(FIRST_SCHEMA);
    }
  }
  // The folder is spelled out in each call so the bundler includes only these files.
  const files = fs.readdirSync(path.join(process.cwd(), "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const statements = splitStatements(fs.readFileSync(path.join(process.cwd(), "db", "migrations", file), "utf8"));
    await db.transaction(async (tx) => {
      for (const statement of statements) await tx.run(statement);
      await tx.run("insert into schema_migrations (name, applied_at) values ($1, $2)", [file, Date.now()]);
    });
    applied.push(file);
  }
  return applied;
}

/** Splits a migration file into statements. The files use no semicolons inside strings or bodies. */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The local database is a folder that only one process may use at a time. A second process
 * (for example `npm run job` while the app is running) is refused instead of damaging it.
 */
function lock(dir: string): void {
  const file = `${dir}.lock`;
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, "utf8"));
    let alive = pid !== process.pid;
    try {
      if (alive) process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`The database is already open in another process (pid ${pid}). Stop the app first, or use "Run now" in Settings.`);
  }
  fs.writeFileSync(file, String(process.pid));
  process.once("exit", () => fs.rmSync(file, { force: true }));
}

/** Opens a local database. With no folder it lives in memory, which the tests use. */
export async function openDb(dir?: string, options: { migrate?: boolean } = {}): Promise<Db> {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    lock(dir);
  }
  const pg = new PGlite(dir);
  await pg.waitReady;
  // Work started inside a transaction joins it.
  const inside = (tx: Queryable): Db => {
    const joined: Db = wrap(tx, (inner) => inner(joined), async () => {});
    return joined;
  };
  const db: Db = wrap(pg, (work) => pg.transaction((tx) => work(inside(tx))) as never, () => pg.close());
  if (options.migrate !== false) await migrate(db);
  return db;
}

/**
 * Reads a connection string. A password with @, # or / in it breaks the address unless those
 * are percent-encoded, and the pieces would then be taken for the host: refuse it instead.
 */
function parseDatabaseUrl(url: string): URL {
  const parsed = new URL(url);
  if (url.split("@").length > 2 || parsed.hash || parsed.pathname.split("/").length > 2) throw new TypeError("Invalid URL");
  return parsed;
}

/**
 * Opens the hosted database from its connection string. Works with Supabase's direct
 * connection and with both of its poolers.
 */
export async function openRemote(url: string, options: { max?: number } = {}): Promise<Db> {
  const { hostname, searchParams } = parseDatabaseUrl(url);
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  const sql = postgres(url, {
    // Enough connections for a screen's worth of reads to go out side by side.
    max: options.max ?? 10,
    // The app uses no array or custom column types, so there is nothing to look up on connect.
    fetch_types: false,
    // Encrypt the connection to anything that is not this computer, unless the address says how.
    ...(local || searchParams.has("sslmode") || searchParams.has("ssl") ? {} : { ssl: "require" as const }),
    connect_timeout: 15,
    // Kept open between the page's checks (one a minute while it is on screen, see store.ts), so a
    // check finds a connection ready instead of opening a new one first.
    idle_timeout: 120,
    // Supabase's transaction pooler does not support prepared statements.
    prepare: false,
    onnotice: () => {},
    types: {
      // Instants are epoch milliseconds in bigint columns. Read them as numbers, as PGlite does.
      bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
      // Lists and objects are handed over as JSON text already. Pass that through, as PGlite
      // does; encoding it a second time would store one long string instead.
      json: { to: 114, from: [114, 3802], serialize: (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)), parse: (v: string) => JSON.parse(v) },
    },
  });
  type Runner = { unsafe(query: string, params?: never[]): Promise<unknown[] & { count: number }> };
  const over = (runner: Runner, transaction: Db["transaction"], close: Db["close"]): Db => ({
    query: async <T>(text: string, params: unknown[] = []) => [...(await runner.unsafe(text, params as never[]))] as T[],
    run: async (text, params = []) => (await runner.unsafe(text, params as never[])).count,
    transaction,
    close,
  });
  const inside = (tx: Runner): Db => {
    const joined: Db = over(tx, (inner) => inner(joined), async () => {});
    return joined;
  };
  const db: Db = over(sql as unknown as Runner, (work) => sql.begin((tx) => work(inside(tx as unknown as Runner))) as never, () => sql.end());
  await migrate(db);
  return db;
}

// One database per server process, kept across hot reloads in development.
const holder = globalThis as unknown as { __commandCenterDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  // A test uses a database of its own (see testing.ts), never the one on this machine.
  if (process.env.VITEST && !process.env.DATABASE_URL && !process.env.DATABASE_DIR) {
    return Promise.reject(new Error("A test tried to open this computer's own database. Give it a test database instead."));
  }
  if (!holder.__commandCenterDb) {
    const opening = process.env.DATABASE_URL
      ? openRemote(process.env.DATABASE_URL)
      : openDb(process.env.DATABASE_DIR ?? path.join(process.cwd(), ".data", "pg"));
    // A failed connection is not kept: the next request tries again.
    opening.catch(() => {
      if (holder.__commandCenterDb === opening) holder.__commandCenterDb = undefined;
    });
    holder.__commandCenterDb = opening;
  }
  return holder.__commandCenterDb;
}

/** Turns a connection failure into what to do about it. Never includes the address. */
export function describeDbError(error: unknown): string {
  const e = error as { code?: string; message?: string };
  const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
  if (/28P01|password authentication failed/i.test(text)) return "The database refused the password. Copy the connection string again from Supabase, Connect, and put the database password in place of [YOUR-PASSWORD].";
  if (/ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN/i.test(text)) return "The database address could not be reached. Supabase's direct connection needs IPv6, which most hosts and many networks do not have. Use a pooler connection string instead: the Transaction pooler on a host such as Vercel, the Session pooler on your own machine.";
  if (/CONNECT_TIMEOUT|ETIMEDOUT|ECONNREFUSED/i.test(text)) return "The database did not answer. Check the connection string, and that the Supabase project is not paused.";
  if (/Tenant or user not found|XX000/i.test(text)) return "Supabase does not know this project or user. Copy the pooler connection string again from Supabase, Connect.";
  if (/Invalid URL/i.test(text)) return "DATABASE_URL is not a valid address. If the password has symbols such as @ # / in it, they must be percent-encoded.";
  return e?.message ?? "The database could not be opened.";
}

/** Where the data lives, for showing on screen and in logs. Never includes the password. */
export function databaseHome(): string {
  if (!process.env.DATABASE_URL) return "This computer (development database)";
  try {
    return parseDatabaseUrl(process.env.DATABASE_URL).hostname;
  } catch {
    return "Hosted database (the address is not valid)";
  }
}
