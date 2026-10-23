// Behaviour tests from docs/expected-behaviour.md section 14, "Cover image"
// (CV1–CV6). Written from the spec, not the code: a failure means one of them
// is wrong.
//
// Sub-tasks aren't built yet, so the "or sub-task" parts of CV1/CV2 (and the
// sub-task half of CV6) are not tested here: tasks only.
//
// Tasks are made the way the New/Edit form makes them: RawReminder ->
// validateInput -> createReminder / updateReminder, with the cover through
// checkCover (what the form's server action runs on the uploaded file), as
// olga, a Company Admin, so nothing waits for approval. Every date is in 2031
// and every worker call gets an explicit `now`, so a live worker on the same
// database never sends these.
//
// Left for the browser: the banner's look on the task page, and the image
// route answering a signed-in request (no test here can sign a request in).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { crc32 } from "node:zlib";
import { db } from "@/db";
import { ownerDb } from "@/worker/db";
import { deliverOne, dispatchDue } from "@/worker/delivery";
import { syncGoogle } from "@/worker/google-sync";
import type { CheckedFile } from "./attachments";
import { authDb } from "./auth";
import { encrypt } from "./crypto";
import { connectGoogle } from "./google-calendar";
import type { sendMail } from "./mail";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  checkCover,
  COVER_MAX_BYTES,
  coverFile,
  coverUrl,
  createReminder,
  type RawReminder,
  reminderAccess,
  updateReminder,
  validateInput,
} from "./reminders";
import { seeder } from "./test-helpers";
import { calendarRange } from "./views";

const s = seeder();
const other = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

let olga: string, alice: string, bob: string;
const emailOf = (id: string) => `${id}@${s.domain}`;
const actor = async (id: string) => ({ id, email: emailOf(id), access: await loadAccess(s.companyId, id) });
const TEAM = () => `T-${s.companyId}`;
const DAY = 86_400_000;

// Real 2×2 images (made with sharp), plus a 1×1 PNG.
const PNG = hex(
  "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000970485973000003e8000003e801b57b526b00000012494441540899633891627422c5880142010028ae05799f5e3f950000000049454e44ae426082",
);
const PNG_1x1 = hex(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d20000000049454e44ae426082",
);
const JPEG = hex(
  "ffd8ffdb00430006040506050406060506070706080a100a0a09090a140e0f0c1017141818171416161a1d251f1a1b231c1616202c20232627292a29191f2d302d283025282928ffdb0043010707070a080a130a0a13281a161a2828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828ffc00011080002000203012200021101031101ffc4001500010100000000000000000000000000000003ffc40014100100000000000000000000000000000000ffc40014010100000000000000000000000000000006ffc40014110100000000000000000000000000000000ffda000c03010002110311003f009001e7cfffd9",
);
const GIF = hex("474946383961020002008000004c6971c8643221f90405000000002c00000000020002000002028c53003b");
const WEBP = hex(
  "524946463a00000057454250565038202e000000f001009d012a0200020001402625a00274ba01f80004c80000feae17ff36040cd0fa60ffd26cf136789b3e398000",
);

// A valid PNG of exactly `size` bytes: PNG with a tEXt chunk (correct CRC) before IEND.
function pngOfSize(size: number) {
  const iend = PNG.length - 12;
  const dataLen = size - PNG.length - 12;
  assert.ok(dataLen > 8);
  const data = Buffer.alloc(dataLen, 0x61);
  Buffer.from("Comment\0").copy(data);
  const type = Buffer.from("tEXt");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dataLen);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const out = Buffer.concat([Buffer.from(PNG.subarray(0, iend)), len, type, data, crc, Buffer.from(PNG.subarray(iend))]);
  assert.equal(out.length, size);
  return new Uint8Array(out);
}
const same = (a: Buffer | Uint8Array | undefined, b: Uint8Array) => !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const cover = (name: string, bytes: Uint8Array): CheckedFile => {
  const r = checkCover(name, bytes);
  assert.ok("image" in r, `${name} accepted as a cover: ${JSON.stringify("error" in r ? r.error : "")}`);
  return r.image;
};
const coverRows = async (reminderId: string) => (await q("select content_type, data from reminder_covers where reminder_id = $1", [reminderId])) as { content_type: string; data: Buffer }[];

// --- Making entries the way the form does -----------------------------------------

const local = (d: Date) => d.toISOString().slice(0, 16); // company zone is UTC
const NO_REPEAT = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
type Kind = "task" | "reminder" | "event";
function input(o: { kind?: Kind; title?: string; sendAt: Date; users?: string[]; channels?: string[] }) {
  const kind = o.kind ?? "task";
  const raw: RawReminder = {
    title: o.title ?? "Onboarding",
    description: "Welcome aboard.",
    senderName: "",
    linkLabels: [],
    linkUrls: [],
    company: false,
    departmentIds: [],
    groupIds: [],
    userIds: o.users ?? [alice],
    emails: "",
    when: "later",
    sendAtLocal: local(o.sendAt),
    repeat: NO_REPEAT,
    isTask: kind === "task",
    dueLocal: kind === "task" ? local(new Date(o.sendAt.getTime() + 2 * DAY)) : "",
    channels: o.channels ?? ["email"],
    slackChannelIds: [],
    tags: "",
    shareMine: false,
    shareDepartmentIds: [],
    shareGroupIds: [],
    shareCompany: false,
    isEvent: kind === "event",
    endLocal: kind === "event" ? local(new Date(o.sendAt.getTime() + 3_600_000)) : "",
    allDay: false,
    location: kind === "event" ? "Room 2" : "",
    meetingUrl: "",
    notifyBefore: [],
    remindBefore: [],
    remindCustom: "",
    remindUnit: "minutes",
  };
  const r = validateInput(raw, "UTC", "Alerts | Test Co", new Date(), []);
  assert.ok("input" in r && r.input, `form accepted: ${JSON.stringify(r)}`);
  return r.input;
}
let n = 0;
const nextSend = () => new Date(Date.UTC(2031, 2, 3 + n++, 9));
async function make(o: { kind?: Kind; sendAt?: Date; users?: string[]; channels?: string[]; title?: string }, c?: CheckedFile | null) {
  const r = await createReminder(await actor(olga), s.companyId, input({ ...o, sendAt: o.sendAt ?? nextSend() }), [], c);
  if ("error" in r) return { error: r.error as string, id: undefined };
  return { error: undefined, id: r.id as string };
}
async function task(c?: CheckedFile | null, o: { sendAt?: Date; users?: string[]; channels?: string[]; title?: string } = {}) {
  const r = await make(o, c);
  assert.equal(r.error, undefined, `task saved: ${r.error}`);
  const [{ status }] = await q("select status from reminders where id = $1", [r.id]);
  assert.equal(status, "scheduled", "saved without approval");
  return r.id!;
}

// --- Worker helpers ------------------------------------------------------------------

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
function fakeSlack() {
  const posts: { channel: string; text: string; blocks: string; all: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop();
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: `U-${p.get("email")}` } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D-${p.get("users")}` } });
    if (method === "chat.postMessage") {
      posts.push({ channel: p.get("channel")!, text: p.get("text")!, blocks: p.get("blocks") ?? "", all: p.toString() });
      return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    }
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f, posts };
}

before(async () => {
  await s.company();
  await other.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  bob = await s.user({ roles: [MEMBER_ROLE_ID] });
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    TEAM(),
    encrypt("xoxb-test"),
  ]);
});
after(async () => {
  await q("delete from google_calendars where user_id = any($1)", [[olga, alice, bob]]);
  await q("delete from deliveries where company_id = $1", [s.companyId]);
  await q("delete from task_assignments where company_id = $1", [s.companyId]);
  await q("delete from reminder_occurrences where company_id = $1", [s.companyId]);
  await q("delete from reminder_covers where company_id = $1", [s.companyId]);
  await other.cleanup();
  await s.cleanup();
  await ownerDb.$client.end();
  await authDb.$client.end();
  await db.$client.end();
});

// --- CV1 -------------------------------------------------------------------------------

test("CV1: a task's cover is a PNG, JPEG, GIF or WebP up to 5 MB, content-checked; anything else refused (sub-tasks not built yet)", async (t) => {
  await t.test("the limit is 5 MB", () => {
    assert.ok(COVER_MAX_BYTES >= 5_000_000 && COVER_MAX_BYTES <= 5 * 1024 * 1024, `about 5 MB (got ${COVER_MAX_BYTES})`);
  });

  await t.test("PNG, JPEG, GIF and WebP, up to exactly the limit, are saved on the task as uploaded", async () => {
    const cases: [string, Uint8Array, string][] = [
      ["cover.png", PNG, "image/png"],
      ["tiny.png", PNG_1x1, "image/png"],
      ["cover.jpg", JPEG, "image/jpeg"],
      ["cover.gif", GIF, "image/gif"],
      ["cover.webp", WEBP, "image/webp"],
      ["big.png", pngOfSize(COVER_MAX_BYTES), "image/png"],
    ];
    for (const [name, bytes, type] of cases) {
      const id = await task(cover(name, bytes));
      const f = await coverFile(s.companyId, id);
      assert.ok(f, `${name} stored`);
      assert.equal(f.contentType, type, `${name} content type`);
      assert.ok(same(f.data, bytes), `${name} bytes stored as uploaded`);
    }
  });

  await t.test("over 5 MB, a PDF, an SVG, a text file named .png, and an empty file are refused with a message", () => {
    const bad: [string, Uint8Array][] = [
      ["huge.png", pngOfSize(COVER_MAX_BYTES + 1)],
      ["doc.pdf", new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n")],
      ["pic.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["notes.png", new TextEncoder().encode("just some text pretending to be a picture\n")],
      ["empty.png", new Uint8Array(0)],
      ["zip.png", hex("504b0304140000000000")],
    ];
    for (const [name, bytes] of bad) {
      const r = checkCover(name, bytes);
      assert.ok("error" in r, `${name} refused`);
      assert.equal(typeof r.error, "string");
      assert.ok(r.error.length > 0, `${name}: a message`);
    }
  });

  await t.test("not by name: a PNG named .jpg is never stored as a JPEG", async () => {
    const r = checkCover("cover.jpg", PNG);
    if ("image" in r) {
      assert.equal(r.image.contentType, "image/png", "the type comes from the bytes, not the name");
      const id = await task(r.image);
      assert.equal((await coverFile(s.companyId, id))?.contentType, "image/png");
    }
  });

  await t.test("a task saved without a cover has none", async () => {
    const id = await task();
    assert.equal(await coverFile(s.companyId, id), null);
    assert.equal(await coverUrl(s.companyId, id), null);
    assert.equal((await coverRows(id)).length, 0);
  });
});

// --- CV2 -------------------------------------------------------------------------------

test("CV2: the task page gets the cover's URL to show as a banner (sub-tasks not built yet)", async (t) => {
  const id = await task(cover("cover.png", PNG));
  const url = await coverUrl(s.companyId, id);
  assert.ok(url, "the task page has a cover URL");
  assert.match(url, new RegExp(`^/api/cover/${id}(\\?.*)?$`), `served by the cover route: ${url}`);
  assert.equal(await coverUrl(s.companyId, await task()), null, "no cover: no banner");

  await t.test("shown as a banner across the top of the task page", { skip: "browser check: the banner's look and place on the task page" }, () => {});
});

// --- CV3 -------------------------------------------------------------------------------

test("CV3: whoever can open the task sees the cover; nobody else; no public URL", async (t) => {
  const SEND = nextSend();
  const id = await task(cover("cover.png", PNG), { sendAt: SEND, users: [alice] });
  // Send it, so alice (the assignee) can open it.
  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, SEND);
  for (const d of sends) await deliverOne(d, capture([]), fakeSlack().f);
  const r = { id, createdBy: olga };

  await t.test("the creator and the assignee can open it, and the cover is there for them", async () => {
    assert.equal(await reminderAccess(s.companyId, await actor(olga), r), "full", "creator");
    assert.notEqual(await reminderAccess(s.companyId, await actor(alice), r), null, "assignee, once sent");
    const f = await coverFile(s.companyId, id);
    assert.ok(f && same(f.data, PNG));
  });

  await t.test("a member it wasn't sent or shared to can't open it", async () => {
    assert.equal(await reminderAccess(s.companyId, await actor(bob), r), null);
  });

  await t.test("another company can't read it", async () => {
    assert.equal(await coverFile(other.companyId, id), null);
    assert.equal(await coverUrl(other.companyId, id), null);
  });

  await t.test("the URL is the app's checked route, not a public file link", async () => {
    const url = (await coverUrl(s.companyId, id)) ?? "";
    assert.ok(url.startsWith(`/api/cover/${id}`), `an app route: ${url}`);
    assert.doesNotMatch(url, /^https?:|token=|sig=|signature|X-Amz/i, "no public or signed link");
  });

  await t.test("the route without a signed-in member never returns the image", async () => {
    const { GET } = (await import("@/app/api/cover/[id]/route")) as unknown as {
      GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    };
    let res: Response | undefined;
    try {
      res = await GET(new Request(`http://localhost/api/cover/${id}`), { params: Promise.resolve({ id }) });
    } catch {
      res = undefined; // refused (no request / session)
    }
    if (res) {
      assert.notEqual(res.status, 200, "not served");
      assert.doesNotMatch(res.headers.get("content-type") ?? "", /^image\//, "no image");
    }
  });

  await t.test("the route checks the viewer can open the task (signed in: allowed member 200, other member 404)", { skip: "browser check: needs signed-in requests to /api/cover/<id>" }, () => {});
});

// --- CV4 -------------------------------------------------------------------------------

test("CV4: replacing or removing the cover deletes the old file", async (t) => {
  const SEND = nextSend();
  const id = await task(cover("one.png", PNG), { sendAt: SEND });
  const pngBefore = await pngCoversElsewhere(id);
  const me = await actor(olga);
  const edit = (c?: CheckedFile | null) => updateReminder(me, s.companyId, id, input({ sendAt: SEND, users: [alice] }), [], [], c);

  await t.test("keeping it (no new file) leaves it as is", async () => {
    const r = await edit(undefined);
    assert.equal(r, null, `saved: ${JSON.stringify(r)}`);
    const f = await coverFile(s.companyId, id);
    assert.ok(f && same(f.data, PNG) && f.contentType === "image/png");
  });

  await t.test("replacing: the new image is served, the old one is gone", async () => {
    const r = await edit(cover("two.jpg", JPEG));
    assert.equal(r, null, `saved: ${JSON.stringify(r)}`);
    const f = await coverFile(s.companyId, id);
    assert.ok(f && same(f.data, JPEG) && f.contentType === "image/jpeg", "the new cover");
    const rows = await coverRows(id);
    assert.equal(rows.length, 1, "one cover per task");
    assert.ok(same(rows[0].data, JPEG), "the stored file is the new one");
    assert.equal(await pngCoversElsewhere(id), pngBefore, "the old file is not kept anywhere else");
  });

  await t.test("removing: nothing left stored, no URL", async () => {
    const r = await edit(null);
    assert.equal(r, null, `saved: ${JSON.stringify(r)}`);
    assert.equal(await coverFile(s.companyId, id), null);
    assert.equal(await coverUrl(s.companyId, id), null);
    assert.equal((await coverRows(id)).length, 0, "the file is deleted");
  });
});
// Other tasks in this file also use PNG as their cover; only theirs may remain.
const pngCoversElsewhere = async (except: string) =>
  (await q("select 1 from reminder_covers where company_id = $1 and data = $2 and reminder_id <> $3", [s.companyId, Buffer.from(PNG), except])).length;

// --- CV5 -------------------------------------------------------------------------------

test("CV5: emails, Slack, the calendar and Google carry no image; only the task page shows it", async (t) => {
  const SEND = nextSend();
  // olga, connected to a fake Google, creates and is herself an assignee.
  const g = fakeGoogle();
  assert.equal(await connectGoogle(s.companyId, olga, `code-${randomUUID()}`, g.fetch), null, "Google connected");
  const id = await task(cover("cover.png", PNG), { sendAt: SEND, users: [alice, olga], channels: ["email", "slack"], title: "Cover check" });
  const COVER = new RegExp(`/api/cover|reminder_covers|${id}\\?v=|image/png|data:image`, "i");

  const sends: string[] = [];
  await dispatchDue(async (x) => void sends.push(...x), s.companyId, SEND);
  const mails: Mail[] = [];
  const sl = fakeSlack();
  for (const d of sends) await deliverOne(d, capture(mails), sl.f);

  await t.test("the emails: no image, no cover link, no image attachment", () => {
    assert.ok(mails.length > 0, "the task was emailed");
    for (const m of mails) {
      const all = JSON.stringify({ ...m, attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType })) });
      assert.doesNotMatch(all, COVER, `no cover in: ${all}`);
      for (const a of m.attachments ?? []) assert.doesNotMatch(a.contentType, /^image\//, `no image attached: ${a.filename}`);
      for (const a of m.attachments ?? []) assert.ok(!same(a.content, PNG), "the cover bytes aren't attached");
    }
  });

  await t.test("the Slack messages: no image block or cover link", () => {
    assert.ok(sl.posts.length > 0, "the task went to Slack");
    for (const p of sl.posts) {
      assert.doesNotMatch(p.all, COVER, `no cover in: ${p.all}`);
      assert.doesNotMatch(p.blocks, /"type"\s*:\s*"image"|image_url/, "no image block");
    }
  });

  await t.test("the in-app calendar entry has no image", async () => {
    const entries = await calendarRange(s.companyId, await actor(olga), "UTC", { from: local(SEND).slice(0, 10), to: local(new Date(SEND.getTime() + DAY)).slice(0, 10) });
    const mine = [...(entries?.days.values() ?? [])].flat().filter((e) => e.reminderId === id);
    assert.ok(mine.length > 0, "the task is on the calendar");
    for (const e of mine) assert.doesNotMatch(JSON.stringify(e), /"(cover|image)\w*"\s*:|\/api\/cover|data:image/i, `no cover in: ${JSON.stringify(e)}`);
  });

  await t.test("the in-app notifications have no image", async () => {
    const rows = await q("select * from notifications where company_id = $1", [s.companyId]);
    for (const r of rows) assert.doesNotMatch(JSON.stringify(r), /\/api\/cover|data:image/i);
  });

  await t.test("the Google Calendar event has no image or attachment", async () => {
    const result = await syncGoogle(olga, g.fetch, new Date(SEND.getTime() - DAY));
    assert.equal(result, "synced");
    assert.ok(g.writes.length > 0, "something was written to Google");
    for (const w of g.writes) {
      assert.doesNotMatch(w.body, COVER, `no cover in: ${w.body}`);
      assert.doesNotMatch(w.body, /"attachments"/, "no attachments on the event");
    }
  });
});

// A minimal fake Google: token exchange, calendar create, event writes.
function fakeGoogle() {
  const calls: { method: string; url: string; body: string }[] = [];
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const email = `p${randomUUID().slice(0, 8)}@gmail.com`;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    calls.push({ method, url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return json({
        access_token: `ya29.fake-${randomUUID()}`,
        expires_in: 3599,
        token_type: "Bearer",
        refresh_token: `1//fake-${randomUUID()}`,
        scope: "openid email https://www.googleapis.com/auth/calendar.app.created",
        id_token: `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", sub: email, email, email_verified: true })}.sig`,
      });
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    const path = new URL(url).pathname.replace(/^\/calendar\/v3/, "");
    if (path === "/calendars" && method === "POST") return json({ id: `${randomUUID()}@group.calendar.google.com`, summary: "NotifyHub" });
    if (method === "GET" && path.endsWith("/events")) return json({ items: [] });
    if (method === "GET") return json({ error: { code: 404, message: "Not Found" } }, 404);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json(JSON.parse(body || "{}"));
  }) as typeof fetch;
  return {
    fetch: f,
    get writes() {
      return calls.filter((c) => c.url.startsWith("https://www.googleapis.com/calendar/v3") && c.method !== "GET");
    },
  };
}

// --- CV6 -------------------------------------------------------------------------------

test("CV6: only tasks have a cover; reminders and events have no cover option (sub-tasks not built yet)", async (t) => {
  for (const kind of ["reminder", "event"] as const) {
    await t.test(`a ${kind} saved with a cover file keeps no cover`, async () => {
      const r = await make({ kind }, cover("cover.png", PNG));
      if (r.id) {
        assert.equal(await coverFile(s.companyId, r.id), null, `${kind}: no cover stored`);
        assert.equal(await coverUrl(s.companyId, r.id), null, `${kind}: no cover URL`);
        assert.equal((await coverRows(r.id)).length, 0);
      }
    });
    await t.test(`editing a ${kind} with a cover file adds none`, async () => {
      const sendAt = nextSend();
      const r = await make({ kind, sendAt });
      assert.equal(r.error, undefined, `${kind} saved: ${r.error}`);
      await updateReminder(await actor(olga), s.companyId, r.id!, input({ kind, sendAt }), [], [], cover("cover.png", PNG));
      assert.equal(await coverFile(s.companyId, r.id!), null, `${kind}: no cover stored`);
      assert.equal(await coverUrl(s.companyId, r.id!), null, `${kind}: no cover URL`);
    });
  }

  await t.test("a task changed into a reminder loses its cover", async () => {
    const sendAt = nextSend();
    const id = await task(cover("cover.png", PNG), { sendAt });
    const r = await updateReminder(await actor(olga), s.companyId, id, input({ kind: "reminder", sendAt }));
    assert.equal(r, null, `saved: ${JSON.stringify(r)}`);
    assert.equal(await coverUrl(s.companyId, id), null, "a reminder shows no cover");
    assert.equal((await coverRows(id)).length, 0, "and keeps no file");
  });

  await t.test("the New/Edit form shows the cover field only for a task", { skip: "browser check: the form's cover field shows only when Task is picked" }, () => {});
});
