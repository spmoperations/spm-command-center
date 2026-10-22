// App keys kept in the database for each person, and accounts that keep the keys they were connected with.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptSettingsKeys, keysById, keysForNew, keysOnScreen, retireKeys, saveKeys } from "./app-keys";
import type { Db } from "./db";
import { checkGoogleKeys, googleApi, GoogleSaid } from "./google";
import { applyAction, loadState, OWNER_ID } from "./repo";
import { seal } from "./secrets";
import type { Fetch } from "./slack";
import { giveTelegramCode, startTelegramLogin, type TelegramDoor } from "./telegram";
import { NOW, reset, testDb } from "./testing";

let db: Db;
const now = new Date(NOW);
const JEREMY = { clientId: "1111-jeremy.apps.googleusercontent.com", clientSecret: "GOCSPX-jeremy-secret" };
const ALEX_OWN = { clientId: "2222-alex.apps.googleusercontent.com", clientSecret: "GOCSPX-alex-secret" };
const SETTINGS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_HOSTED", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_HOSTED", "ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID", "DATABASE_URL", "VERCEL"];

function jeremysSettings() {
  process.env.GOOGLE_CLIENT_ID = JEREMY.clientId;
  process.env.GOOGLE_CLIENT_SECRET = JEREMY.clientSecret;
  process.env.TELEGRAM_API_ID = "123456";
  process.env.TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
}

async function addAlex(): Promise<string> {
  await applyAction(db, "addTeamLogin", ["Alex", "alex@example.com", "a long enough password"], OWNER_ID, now);
  return (await db.query<{ id: string }>("select id from users where login_email = 'alex@example.com'"))[0].id;
}

/** A Google that answers the token address, and remembers which app asked. */
function googleToken(answer: (body: URLSearchParams) => [number, unknown]) {
  const asked: URLSearchParams[] = [];
  const fetchImpl: Fetch = async (_input, init) => {
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    asked.push(body);
    const [status, json] = answer(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, asked };
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  await reset(db);
});
afterEach(() => {
  for (const name of SETTINGS) delete process.env[name];
});

describe("keys from the server's settings", () => {
  it("are copied in once, sealed, as the owner's keys, and never shown whole", async () => {
    jeremysSettings();
    const notes = await adoptSettingsKeys(db, NOW);
    expect(notes.length).toBe(3);
    expect(notes.join(" ")).not.toContain(JEREMY.clientSecret);
    const rows = await db.query<{ owner_id: string; provider: string; secret: string; label: string; from_env: boolean }>("select owner_id, provider, secret, label, from_env from app_keys order by provider");
    expect(rows.map((r) => [r.owner_id, r.provider, r.from_env])).toEqual([[OWNER_ID, "anthropic", true], [OWNER_ID, "google", true], [OWNER_ID, "telegram", true]]);
    for (const r of rows) expect(`${r.secret} ${r.label}`).not.toMatch(/GOCSPX-jeremy-secret|0123456789abcdef0123456789abcdef|sk-ant-not-a-real-key/);
    expect((await keysForNew(db, OWNER_ID, "google"))?.keys).toEqual(JEREMY);
    // A second start copies nothing more, even when the settings have changed since.
    process.env.GOOGLE_CLIENT_ID = "9999-other.apps.googleusercontent.com";
    expect(await adoptSettingsKeys(db, NOW + 1)).toEqual([]);
    expect((await db.query("select id from app_keys")).length).toBe(3);
  });

  it("never reach the hosted database from a developer's machine, only from the live site", async () => {
    jeremysSettings();
    process.env.DATABASE_URL = "postgres://u:p@db.example.com:5432/postgres";
    expect(await adoptSettingsKeys(db, NOW)).toEqual([]);
    // The live site, with Google switched on there and Telegram not.
    process.env.GOOGLE_HOSTED = "true";
    await adoptSettingsKeys(db, NOW);
    expect((await db.query<{ provider: string }>("select provider from app_keys order by provider")).map((r) => r.provider)).toEqual(["anthropic", "google"]);
  });
});

describe("whose keys a connection uses", () => {
  it("uses a person's own keys, else the team's, else the server's settings", async () => {
    const alex = await addAlex();
    expect(await keysForNew(db, alex, "google")).toBeNull();
    jeremysSettings();
    expect((await keysForNew(db, alex, "google"))?.whose).toBe("settings");
    await adoptSettingsKeys(db, NOW);
    expect(await keysForNew(db, alex, "google")).toMatchObject({ whose: "team", keys: JEREMY });
    await saveKeys(db, alex, "google", ALEX_OWN, NOW);
    expect(await keysForNew(db, alex, "google")).toMatchObject({ whose: "own", keys: ALEX_OWN });
    // Her own never become anyone else's.
    expect(await keysForNew(db, OWNER_ID, "google")).toMatchObject({ whose: "own", keys: JEREMY });
    await retireKeys(db, alex, "google", NOW + 1);
    expect(await keysForNew(db, alex, "google")).toMatchObject({ whose: "team", keys: JEREMY });
    const screen = await keysOnScreen(db, alex, "google");
    expect(screen).toEqual({ using: "team", label: "Client ID 1111-j…remy", own: null });
    expect(JSON.stringify((await loadState(db, alex, now)).appKeys)).not.toContain("GOCSPX");
  });

  it("keeps each account on the keys it was connected with, whatever is saved later", async () => {
    jeremysSettings();
    await adoptSettingsKeys(db, NOW);
    const alex = await addAlex();
    const team = await keysForNew(db, alex, "google");
    // Saving new keys later, for her or for the owner, leaves the keys the account was made with in place.
    await saveKeys(db, alex, "google", ALEX_OWN, NOW + 1);
    await saveKeys(db, OWNER_ID, "google", { clientId: "3333-new.apps.googleusercontent.com", clientSecret: "GOCSPX-new" }, NOW + 2);
    expect((await keysById(db, alex, "google", team!.id))?.keys).toEqual(JEREMY);
    // An account connected before keys were kept here (no id) was connected with the settings: the owner's first keys.
    expect((await keysById(db, OWNER_ID, "google", null))?.keys).toEqual(JEREMY);
    expect((await keysById(db, alex, "google", null))?.keys).toEqual(JEREMY);
  });

  it("never hands one person's own keys to another", async () => {
    const alex = await addAlex();
    await applyAction(db, "addTeamLogin", ["Sam", "sam@example.com", "a long enough password"], OWNER_ID, now);
    const sam = (await db.query<{ id: string }>("select id from users where login_email = 'sam@example.com'"))[0].id;
    const alexKeys = await saveKeys(db, alex, "google", ALEX_OWN, NOW);
    expect(await keysById(db, sam, "google", alexKeys)).toBeNull();
    expect((await keysById(db, alex, "google", alexKeys))?.keys).toEqual(ALEX_OWN);
  });
});

describe("Google with saved keys", () => {
  async function account(ownerId: string, keyId: string | null) {
    await db.run("insert into google_accounts (owner_id, email, secret, scopes, start_history, connected_at, app_key_id) values ($1, 'jeremy@example.com', $2, 'https://www.googleapis.com/auth/gmail.readonly', '100', $3, $4)", [
      ownerId,
      seal(JSON.stringify({ refresh: "refresh-token" })),
      NOW,
      keyId,
    ]);
  }

  it("refreshes an account with the keys it was connected with, even after the owner saves new ones", async () => {
    jeremysSettings();
    await adoptSettingsKeys(db, NOW);
    // Connected before keys were kept here, as Jeremy's is.
    await account(OWNER_ID, null);
    await saveKeys(db, OWNER_ID, "google", { clientId: "3333-new.apps.googleusercontent.com", clientSecret: "GOCSPX-new" }, NOW + 1);
    // And the settings are gone from the server.
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const google = googleToken(() => [200, { access_token: "a", expires_in: 3600 }]);
    await googleApi(db, OWNER_ID, "jeremy@example.com", google.fetchImpl);
    expect([google.asked[0].get("client_id"), google.asked[0].get("client_secret"), google.asked[0].get("refresh_token")]).toEqual([JEREMY.clientId, JEREMY.clientSecret, "refresh-token"]);
  });

  it("asks Google nothing and keeps the account when its keys are missing", async () => {
    await account(OWNER_ID, "k_gone");
    const google = googleToken(() => [400, { error: "invalid_grant" }]);
    await expect(googleApi(db, OWNER_ID, "jeremy@example.com", google.fetchImpl)).rejects.toThrow(GoogleSaid);
    expect(google.asked).toEqual([]);
    expect((await db.query("select email from google_accounts")).length).toBe(1);
  });

  it("checks keys with Google before they are saved", async () => {
    const right = googleToken(() => [400, { error: "invalid_grant" }]);
    await expect(checkGoogleKeys(JEREMY, "http://127.0.0.1:3100/api/google/callback", right.fetchImpl)).resolves.toBeUndefined();
    expect(right.asked[0].get("client_id")).toBe(JEREMY.clientId);
    const wrong = googleToken(() => [401, { error: "invalid_client" }]);
    await expect(checkGoogleKeys(JEREMY, "http://127.0.0.1:3100/api/google/callback", wrong.fetchImpl)).rejects.toThrow("Google does not know these keys");
  });
});

describe("Telegram with saved keys", () => {
  it("logs in with the person's keys, and the login keeps them", async () => {
    jeremysSettings();
    await adoptSettingsKeys(db, NOW);
    const alex = await addAlex();
    const used: unknown[] = [];
    const door = (_session: string, keys: unknown): Promise<TelegramDoor> => {
      used.push(keys);
      return Promise.resolve({
        sendCode: async () => ({ hash: "h", via: "app" as const }),
        signIn: async () => "done" as const,
        passwordHint: async () => undefined,
        checkPassword: async () => {},
        me: async () => ({ name: "Alex", phone: "+447700900123" }),
        session: () => "alex-session",
        close: async () => {},
      });
    };
    const first = await startTelegramLogin(db, alex, "+447700900123", door);
    await giveTelegramCode(db, alex, first.pending, "12345", door);
    const team = await keysForNew(db, alex, "telegram");
    expect(used).toEqual([team!.keys, team!.keys]);
    const [row] = await db.query<{ app_key_id: string | null }>("select app_key_id from connections where owner_id = $1 and provider = 'telegram'", [alex]);
    expect(row.app_key_id).toBe(team!.id);
    // Her own keys saved later are for new logins; this one keeps the team's.
    await saveKeys(db, alex, "telegram", { apiId: 7654321, apiHash: "fedcba9876543210fedcba9876543210" }, NOW + 1);
    expect((await keysById(db, alex, "telegram", row.app_key_id))?.keys).toEqual(team!.keys);
    // The owner's Telegram is untouched by all of it.
    expect(await db.query("select provider from connections where owner_id = $1", [OWNER_ID])).toEqual([]);
  });
});
