// Pictures pasted into a Slack reply: kept here when added, shown with the reply, and sent to
// Slack with it, against a pretend Slack. And a reply sent from here shows once when Slack's own
// copy of it comes back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MOST_PICTURE_BYTES } from "@/core/config";
import { outboxSend } from "@/jobs/outbox";
import type { JobContext } from "@/jobs/runner";
import type { AddedPicture } from "@/core/types";
import type { Db } from "./db";
import { pictureResponse, PICTURE_TOO_BIG, uploadResponse } from "./pictures";
import { applyAction, OWNER_ID } from "./repo";
import { seal } from "./secrets";
import { SLACK_NEEDS_UPLOAD, slackClient, SlackError } from "./slack";
import { fakeSlack, NOW, reset, seed, stateOpened, testDb, TINY } from "./testing";

let db: Db;
const ctx = (): JobContext => ({ db, ownerId: OWNER_ID, now: NOW, cursor: {} });
const SITE = "http://127.0.0.1:3100";

/** Adds a picture as the reply box does, and answers its key. */
async function added(bytes: Buffer, now = NOW, ownerId = OWNER_ID): Promise<string> {
  const res = await uploadResponse(db, ownerId, new Request(`${SITE}/api/media`, { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes) }), now);
  expect(res.status).toBe(200);
  return ((await res.json()) as { key: string }).key;
}

async function slackConnected(scopes: string | null) {
  await db.run("insert into connections (owner_id, provider, secret, label, connected_at, scopes) values ($1, 'slack', $2, 'jeremy · SPM', $3, $4)", [OWNER_ID, seal("xoxp-test-token"), NOW, scopes]);
}

const reply = (id: string, text: string, pictures: AddedPicture[], thread: string | null = null, ownerId = OWNER_ID) => applyAction(db, "sendReply", [id, text, false, thread, pictures], ownerId, new Date(NOW));

/** A Slack that takes pictures, and remembers what was handed to it. */
function takesPictures() {
  const uploads: [string, number][] = [];
  let n = 0;
  const slack = fakeSlack({
    "files.getUploadURLExternal": (p) => ({ ok: true, upload_url: `https://files.slack.com/upload/v1/u${++n}`, file_id: `F${n}`, asked: p }),
    "files.completeUploadExternal": () => ({ ok: true, files: [] }),
    "chat.postMessage": () => ({ ok: true, ts: "9.0" }),
  });
  return { slack: { ...slack, upload: async (address: string, bytes: Buffer) => void uploads.push([address, bytes.length]) }, calls: slack.calls, uploads };
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  await reset(db);
  await seed(db);
});
afterEach(() => {
  delete process.env.SENDING_ENABLED;
});

describe("adding a picture to a reply", () => {
  it("keeps a picture, and nothing that is not one, nor one too big to send", async () => {
    const key = await added(TINY.png);
    expect(key).toMatch(/^upload\/[A-Za-z0-9_-]{24}\.png$/);
    expect(await db.query("select owner_id, mime from media where key = $1", [key])).toEqual([{ owner_id: OWNER_ID, mime: "image/png" }]);
    const post = (body: Buffer, headers: Record<string, string> = {}) => uploadResponse(db, OWNER_ID, new Request(`${SITE}/api/media`, { method: "POST", headers: { "content-type": "image/png", ...headers }, body: new Uint8Array(body) }), NOW);
    const notAPicture = await post(Buffer.from("<script>alert(1)</script>, which is not a picture"));
    expect([notAPicture.status, ((await notAPicture.json()) as { error: string }).error]).toEqual([415, "Only a picture can be added: PNG, JPEG, GIF or WebP."]);
    const tooBig = await post(Buffer.concat([TINY.png, Buffer.alloc(MOST_PICTURE_BYTES)]));
    expect([tooBig.status, ((await tooBig.json()) as { error: string }).error]).toEqual([413, PICTURE_TOO_BIG]);
    expect((await db.query("select key from media")).length).toBe(1);
  });

  it("lets go of pictures added over a day ago that were never sent, and keeps those that were", async () => {
    await slackConnected("channels:history,files:read,files:write");
    const dayAgo = NOW - 25 * 3_600_000;
    const takenOut = await added(TINY.png, dayAgo);
    const sent = await added(TINY.jpg, dayAgo);
    await reply("slack:D1", "The cut", [{ key: sent, name: "cut.jpg" }]);
    const fresh = await added(TINY.webp, NOW - 60_000);
    // The next picture added tidies up.
    const latest = await added(TINY.png, NOW);
    const keys = (await db.query<{ key: string }>("select key from media")).map((r) => r.key).sort();
    expect(keys).toEqual([sent, fresh, latest].sort());
    expect(keys).not.toContain(takenOut);
  });
});

describe("a reply with pictures", () => {
  it("shows them with the reply, from here, and sends them to Slack in its thread with the words", async () => {
    await slackConnected("channels:history,files:read,files:write");
    const one = await added(TINY.png);
    const two = await added(TINY.jpg);
    await reply("slack:C1", "Here it is", [{ key: one, name: "image.png", w: 1200, h: 800 }, { key: two, name: "Second take", w: 640, h: 480 }], "1.0");

    const shown = (await stateOpened(db)).inbox.find((c) => c.id === "slack:C1")!.thread.at(-1)!;
    expect(shown).toMatchObject({ me: true, text: "Here it is", status: "queued", thread: "1.0" });
    expect(shown.attachments!.map((p) => [p.name, p.w, p.h, p.here])).toEqual([["image.png", 1200, 800, true], ["Second take", 640, 480, true]]);
    // Served by the dashboard, whatever Slack lets it read.
    const picture = await pictureResponse(db, OWNER_ID, new URL(`${SITE}${shown.attachments![1].src}`).searchParams, async () => {
      throw new Error("Slack is not asked for a picture kept here");
    });
    expect([picture.status, picture.headers.get("content-type"), Buffer.from(await picture.arrayBuffer()).equals(TINY.jpg)]).toEqual([200, "image/jpeg", true]);

    // Sending switched off: nothing goes.
    const off = takesPictures();
    await outboxSend(ctx(), off.slack);
    expect([off.calls, off.uploads]).toEqual([[], []]);

    process.env.SENDING_ENABLED = "true";
    const { slack, calls, uploads } = takesPictures();
    expect(await outboxSend(ctx(), slack)).toMatchObject({ items: 1, message: "Sent 1 of 1" });
    expect(calls).toEqual([
      ["files.getUploadURLExternal", { filename: "image.png", length: TINY.png.length }],
      ["files.getUploadURLExternal", { filename: "Second take.jpg", length: TINY.jpg.length }],
      ["files.completeUploadExternal", { files: JSON.stringify([{ id: "F1", title: "image.png" }, { id: "F2", title: "Second take" }]), channel_id: "C1", initial_comment: "Here it is", thread_ts: "1.0" }],
    ]);
    expect(uploads).toEqual([["https://files.slack.com/upload/v1/u1", TINY.png.length], ["https://files.slack.com/upload/v1/u2", TINY.jpg.length]]);
    expect(await db.query("select status, last_error from outbox")).toEqual([{ status: "sent", last_error: null }]);
    expect((await stateOpened(db)).inbox.find((c) => c.id === "slack:C1")!.thread.at(-1)).toMatchObject({ status: "sent" });
  });

  it("can be a picture alone, with no words", async () => {
    await slackConnected("channels:history,files:read,files:write");
    const key = await added(TINY.png);
    await reply("slack:D1", "  ", [{ key, name: "screen.png" }]);
    const shown = (await stateOpened(db)).inbox.find((c) => c.id === "slack:D1")!.thread.at(-1)!;
    expect([shown.text, shown.attachments?.length]).toEqual(["(sent a picture)", 1]);
    expect((await stateOpened(db)).outbox[0].text).toBe("(a picture)");
    process.env.SENDING_ENABLED = "true";
    const { slack, calls } = takesPictures();
    await outboxSend(ctx(), slack);
    expect(calls.at(-1)).toEqual(["files.completeUploadExternal", { files: JSON.stringify([{ id: "F1", title: "screen.png" }]), channel_id: "D1" }]);
  });

  it("is refused when Slack would not take it, on another app, or with pictures not kept here for this person", async () => {
    const key = await added(TINY.png);
    const refused = (id: string, text: string, pictures: unknown[]) => applyAction(db, "sendReply", [id, text, false, null, pictures], OWNER_ID, new Date(NOW)).then(() => "queued", (e: Error) => e.message);

    await slackConnected("channels:history,files:read");
    expect(await refused("slack:D1", "Look", [{ key, name: "a.png" }])).toBe(SLACK_NEEDS_UPLOAD);
    await db.run("update connections set scopes = 'channels:history,files:read,files:write' where owner_id = $1", [OWNER_ID]);

    await db.run("insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, tagged, last_text, last_at) values ('telegram:42', $1, 'telegram', '42', 'Dana', 'Direct message', true, false, 'Hi', $2)", [OWNER_ID, NOW]);
    expect(await refused("telegram:42", "Look", [{ key, name: "a.png" }])).toBe("Pictures can only be sent on Slack for now.");
    for (const bad of ["upload/../../secrets.png", "telegram/42/7", ""]) expect(await refused("slack:D1", "Look", [{ key: bad, name: "a.png" }])).toBe("Those pictures could not be read. Add them again.");
    expect(await refused("slack:D1", "Look", [{ key, name: "a.png" }, { key, name: "a.png" }])).toBe("Those pictures could not be read. Add them again.");
    expect(await refused("slack:D1", "Look", [{ key: "upload/AAAAAAAAAAAAAAAAAAAAAAAA.png", name: "a.png" }])).toBe("A picture is no longer here. Add it again.");
    expect(await refused("slack:D1", "Look", Array.from({ length: 11 }, () => ({ key, name: "a.png" })))).toBe("At most 10 pictures can go with one message.");
    expect(await refused("slack:D1", "  ", [])).toBe("Write a reply first.");

    // A picture another person added is not theirs to send.
    await applyAction(db, "addTeamLogin", ["Alex", "alex@example.com", "a long enough password"], OWNER_ID, new Date(NOW));
    const alex = (await db.query<{ id: string }>("select id from users where login_email = 'alex@example.com'"))[0].id;
    await db.run("insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, tagged, last_text, last_at) values ('slack:D9', $1, 'slack', 'D9', 'Maya Chen', 'Direct message', true, false, 'Hi', $2)", [alex, NOW]);
    const asAlex = await applyAction(db, "sendReply", ["slack:D9", "Look", false, null, [{ key, name: "a.png" }]], alex, new Date(NOW)).then(() => "queued", (e: Error) => e.message);
    expect(asAlex).toBe("A picture is no longer here. Add it again.");
    expect(await db.query("select id from outbox")).toEqual([]);
  });

  it("says plainly when Slack turns the picture away for want of the permission, and tries again later", async () => {
    // Slack has not said yet what the token may do, so the reply is taken.
    await slackConnected(null);
    const key = await added(TINY.png);
    await reply("slack:D1", "Look", [{ key, name: "a.png" }]);
    process.env.SENDING_ENABLED = "true";
    const slack = fakeSlack({
      "files.getUploadURLExternal": () => {
        throw new SlackError("files.getUploadURLExternal", "missing_scope");
      },
    });
    await outboxSend(ctx(), { ...slack, upload: async () => {} });
    expect(await db.query("select status, last_error from outbox")).toEqual([{ status: "queued", last_error: SLACK_NEEDS_UPLOAD }]);
  });
});

describe("the Slack client's upload", () => {
  it("hands the bytes to Slack's file server only, without the token", async () => {
    const asked: { url: string; auth: string | null; length: number }[] = [];
    const client = slackClient("xoxp-test-token", async (input, init) => {
      asked.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), length: (init?.body as Uint8Array).length });
      return new Response("OK - 24", { status: 200 });
    });
    await client.upload!("https://files.slack.com/upload/v1/abc", TINY.png);
    expect(asked).toEqual([{ url: "https://files.slack.com/upload/v1/abc", auth: null, length: TINY.png.length }]);
    await expect(client.upload!("https://example.com/upload", TINY.png)).rejects.toThrow("not its own");
    expect(asked.length).toBe(1);
  });
});

describe("a reply sent from here", () => {
  it("shows once when Slack's own copy of it has come back, and still shows until then", async () => {
    await applyAction(db, "sendReply", ["slack:D1", "On it.", false], OWNER_ID, new Date(NOW));
    await applyAction(db, "sendReply", ["slack:D1", "On it.", false], OWNER_ID, new Date(NOW + 1_000));
    await db.run("update messages set status = 'sent' where owner_id = $1 and me", [OWNER_ID]);
    const mine = async () => (await stateOpened(db)).inbox.find((c) => c.id === "slack:D1")!.thread.filter((m) => m.me).map((m) => [m.text, m.ts ?? null]);
    expect(await mine()).toEqual([["On it.", null], ["On it.", null]]);
    // Slack's copy of the first one arrives: it stands in for one of the two, not both.
    await db.run("insert into messages (id, conversation_id, owner_id, external_id, sender_name, sender_id, me, body, at) values ('slack:D1:2.0', 'slack:D1', $1, '2.0', 'Jeremy', 'UJEREMY', true, 'On it.', $2)", [OWNER_ID, NOW + 2_000]);
    expect(await mine()).toEqual([["On it.", null], ["On it.", "2.0"]]);
    // Something else the owner wrote in Slack itself hides nothing.
    await db.run("insert into messages (id, conversation_id, owner_id, external_id, sender_name, sender_id, me, body, at) values ('slack:D1:3.0', 'slack:D1', $1, '3.0', 'Jeremy', 'UJEREMY', true, 'Thanks!', $2)", [OWNER_ID, NOW + 3_000]);
    expect(await mine()).toEqual([["On it.", null], ["On it.", "2.0"], ["Thanks!", "3.0"]]);
  });
});
