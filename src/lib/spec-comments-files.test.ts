// Behaviour tests from docs/expected-behaviour.md section 15, "Comments and
// attachments" (CE1–CE5, AW1–AW6, CA1–CA7, FT1–FT7). Written from the spec,
// not the code: a failure means one of them is wrong.
//
// Comments are on a "sent" reminder made straight in the database (as in
// comments.test.ts): `creator` made it, alice and bob received it, carol didn't.
// A reminder's own files go through the form's path: RawReminder ->
// validateInput -> createReminder / updateReminder / detachOccurrence, by olga
// or adam (both Company Admins, so nothing waits for approval). Every date is
// in 2031 and every worker call gets an explicit `now`.
//
// "24 hours later" is made by ageing rows through the owner connection
// (comments.created_at, attachments.created_at).
//
// iWork / OpenDocument / .docx bytes are real (stored, uncompressed) zip files
// built below: iWork 2013+ = a zip holding Index/Document.iwa; iWork '09 = a zip
// holding index.xml; OpenDocument = a zip whose first entry is `mimetype`.
//
// Downloading (src/app/api/attachments/[id]/route.ts) needs a signed-in request;
// its rule is tested through what it uses: the attachment row joined to a
// live reminder, the blob, and reminderAccess. Left for the browser: buttons
// and ticks shown or hidden, the pickers, the rate limit (a server action).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { crc32 } from "node:zlib";
import { db } from "@/db";
import { ownerDb } from "@/worker/db";
import { deliverOne, dispatchDue } from "@/worker/delivery";
import { ACCEPT, type CheckedFile, checkFile, FILE_TYPES, inEditWindow, MAX_FILE_BYTES, mayRemoveFile } from "./attachments";
import { authDb } from "./auth";
import { addComment, deleteComment, editComment, listComments, MAX_FILES_PER_COMMENT } from "./comments";
import { encrypt } from "./crypto";
import type { sendMail } from "./mail";
import { setMutes } from "./notifications";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import {
  createReminder,
  deleteReminder,
  detachOccurrence,
  duplicateReminder,
  listAttachments,
  moveEntry,
  type RawReminder,
  reminderAccess,
  updateReminder,
  validateInput,
} from "./reminders";
import { getBlob } from "./storage";
import { seeder } from "./test-helpers";
import { setActive } from "./users";

const s = seeder();
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const TEAM = () => `T-${s.companyId}`;
const EDIT_REFUSED = "Comments can be edited for 24 hours after posting.";

let olga: string, adam: string, creator: string, alice: string, bob: string, carol: string, reminderId: string;
const emailOf = (id: string) => `${id}@${s.domain}`;
const name = (id: string) => `N-${id.slice(0, 6)}`;
const actor = async (id: string) => ({ id, name: name(id), email: emailOf(id), access: await loadAccess(s.companyId, id) });

type Mail = Parameters<typeof sendMail>[0];
const capture = (box: Mail[]) => (async (m: Mail) => void box.push(m)) as unknown as typeof sendMail;
function fakeSlack() {
  const calls: { method: string; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const json = (b: object) => new Response(JSON.stringify(b));
    const p = init.body as URLSearchParams;
    const method = url.split("/").pop()!;
    calls.push({ method, body: String(p) });
    if (method === "users.lookupByEmail") return json({ ok: true, user: { id: `U-${p.get("email")}` } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: `D-${p.get("users")}` } });
    if (method === "chat.postMessage") return json({ ok: true, channel: p.get("channel"), ts: "1.0" });
    return json({ ok: false, error: "unknown_method" });
  }) as typeof fetch;
  return { f, calls };
}

// --- Files -------------------------------------------------------------------------

const enc = (t: string) => new TextEncoder().encode(t);
const ok = (fileName: string, bytes: Uint8Array): CheckedFile => {
  const r = checkFile(fileName, bytes);
  assert.ok("file" in r, `${fileName} accepted: ${"error" in r ? r.error : ""}`);
  return r.file;
};
const refused = (fileName: string, bytes: Uint8Array) => {
  const r = checkFile(fileName, bytes);
  assert.ok("error" in r, `${fileName} refused`);
  return r.error;
};
const txt = (fileName: string, text = `notes for ${fileName}\n`) => ok(fileName, enc(text));

// A stored (uncompressed) zip.
function zip(entries: [string, string | Uint8Array][]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [n, d] of entries) {
    const nameB = Buffer.from(n);
    const data = Buffer.from(typeof d === "string" ? enc(d) : d);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, data);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const IWORK = zip([
  ["Index/Document.iwa", new Uint8Array([0x00, 0x1f, 0x00, 0x00, 0x08, 0x01])],
  ["Metadata/Properties.plist", '<?xml version="1.0"?><plist/>'],
]);
const IWORK_09 = zip([["index.xml", '<?xml version="1.0"?><sl:document xmlns:sl="http://developer.apple.com/namespaces/sl"/>']]);
const ODF = (type: string) =>
  zip([
    ["mimetype", `application/vnd.oasis.opendocument.${type}`],
    ["content.xml", '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>'],
    ["META-INF/manifest.xml", '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'],
  ]);
const DOCX = zip([
  ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ["word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'],
]);
const PLAIN_ZIP = zip([["a.txt", "hello"]]);

// --- Reminders through the form ----------------------------------------------------

const local = (d: Date) => d.toISOString().slice(0, 16); // company zone is UTC
const NO_REPEAT = { repeat: "none", every: "1", unit: "day", weekdays: [], monthlyBy: "day", ends: "never", until: "", count: "" };
let n = 0;
const nextSend = () => new Date(Date.UTC(2031, 4, 3 + n++, 9));
function input(o: { title?: string; sendAt: Date; users?: string[]; daily?: boolean }) {
  const raw: RawReminder = {
    title: o.title ?? "Policy update",
    description: "Please read.",
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
    repeat: o.daily ? { ...NO_REPEAT, repeat: "daily" } : NO_REPEAT,
    isTask: false,
    dueLocal: "",
    channels: ["email"],
    slackChannelIds: [],
    tags: "",
    shareMine: false,
    shareDepartmentIds: [],
    shareGroupIds: [],
    shareCompany: false,
    isEvent: false,
    endLocal: "",
    allDay: false,
    location: "",
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
type Opts = { title?: string; sendAt?: Date; users?: string[]; daily?: boolean };
async function makeReminder(files: CheckedFile[] = [], by = olga, o: Opts = {}) {
  const sendAt = o.sendAt ?? nextSend();
  const r = await createReminder(await actor(by), s.companyId, input({ ...o, sendAt }), files);
  assert.ok("id" in r, `saved: ${JSON.stringify(r)}`);
  return { id: r.id as string, sendAt, o: { ...o, sendAt } };
}
const save = async (by: string, r: { id: string; o: Opts & { sendAt: Date } }, add: CheckedFile[] = [], remove: string[] = []) =>
  updateReminder(await actor(by), s.companyId, r.id, input(r.o), add, remove);

type FileRow = { id: string; file_name: string; uploaded_by: string | null; created_at: Date; comment_id: string | null; content_type: string };
const filesOf = async (reminder: string) =>
  (await q("select id, file_name, uploaded_by, created_at, comment_id, content_type from attachments where reminder_id = $1 order by created_at, file_name", [
    reminder,
  ])) as FileRow[];
const ownFiles = async (reminder: string) => (await filesOf(reminder)).filter((f) => f.comment_id === null);
const fileByName = async (reminder: string, fileName: string) => (await filesOf(reminder)).find((f) => f.file_name === fileName);
const age = (table: "comments" | "attachments", id: string, hours = 25) => q(`update ${table} set created_at = now() - make_interval(hours => $2) where id = $1`, [id, hours]);
const isRecent = (d: Date) => Date.now() - d.getTime() < 5 * 60_000;

// What the download route serves: the attachment on a live (not deleted) reminder, with its bytes.
async function downloadable(attachmentId: string) {
  const [row] = await q("select a.id from attachments a join reminders r on r.id = a.reminder_id where a.id = $1 and r.deleted_at is null", [attachmentId]);
  return !!row && !!(await getBlob(ownerDb, attachmentId));
}

// --- Comments ---------------------------------------------------------------------

const comment = async (by: string, body: string, o: { files?: CheckedFile[]; mentionIds?: string[]; parentId?: string; on?: string } = {}, deps = {}) => {
  const r = await addComment(await actor(by), s.companyId, o.on ?? reminderId, { body, parentId: o.parentId, mentionIds: o.mentionIds ?? [], files: o.files }, deps);
  assert.ok("id" in r, `comment posted: ${JSON.stringify(r)}`);
  return r.id as string;
};
const edit = async (by: string, id: string, body: string, o: { files?: CheckedFile[]; removeFileIds?: string[]; mentionIds?: string[] } = {}, deps = {}) =>
  (await editComment(await actor(by), s.companyId, id, { body, mentionIds: o.mentionIds ?? [], files: o.files, removeFileIds: o.removeFileIds }, deps)) as
    | { id: string }
    | { error: string };
const thread = async (on = reminderId) => {
  const top = await listComments(s.companyId, on);
  return [...top, ...top.flatMap((c) => c.replies)];
};
const listed = async (id: string, on = reminderId) => (await thread(on)).find((c) => c.id === id);

before(async () => {
  await s.company();
  olga = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  adam = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [creator, alice, bob, carol] = [
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
    await s.user({ roles: [MEMBER_ROLE_ID] }),
  ];
  for (const u of [olga, adam, creator, alice, bob, carol]) await q(`update "user" set name = $2 where id = $1`, [u, name(u)]);
  await q("insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'UBOT')", [
    s.companyId,
    TEAM(),
    encrypt("xoxb-test"),
  ]);
  [{ id: reminderId }] = await q(
    `insert into reminders (company_id, short_id, created_by, title, sender_name, send_at, status, time_zone, anchor_local)
     values ($1, $2, $3, 'Quarterly review', 'S', now(), 'sent', 'UTC', '2026-01-01T00:00') returning id`,
    [s.companyId, `R-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, creator],
  );
  const [{ id: occ }] = await q("insert into reminder_occurrences (company_id, reminder_id, occurs_at, status) values ($1, $2, now(), 'sent') returning id", [
    s.companyId,
    reminderId,
  ]);
  for (const u of [alice, bob])
    await q("insert into deliveries (company_id, reminder_id, occurrence_id, address, user_id, status) values ($1, $2, $3, $4, $4, 'sent')", [
      s.companyId,
      reminderId,
      occ,
      u,
    ]);
});
after(async () => {
  await q("delete from attachment_blobs where company_id = $1", [s.companyId]);
  await q("delete from attachments where company_id = $1", [s.companyId]);
  await q("delete from deliveries where company_id = $1", [s.companyId]);
  await q("delete from reminder_occurrences where company_id = $1", [s.companyId]);
  await s.cleanup();
  await ownerDb.$client.end();
  await authDb.$client.end();
  await db.$client.end();
});

// --- Comment edit window --------------------------------------------------------------

test("CE1: the author edits within 24 hours: saved, marked edited, newly mentioned people told", async () => {
  const id = await comment(alice, "First draft");
  assert.equal((await listed(id))?.editable, true, "editable while fresh");
  const mails: Mail[] = [];
  const r = await edit(alice, id, `Second draft @${name(bob)}`, { mentionIds: [bob] }, { send: capture(mails) });
  assert.ok("id" in r, `edit saved: ${JSON.stringify(r)}`);
  const c = await listed(id);
  assert.equal(c?.body, `Second draft @${name(bob)}`);
  assert.equal(c?.edited, true);
  assert.deepEqual(
    mails.map((m) => m.to),
    [emailOf(bob)],
    "bob (newly mentioned) is told",
  );
});

test("CE2: after 24 hours the author's edit is refused with the message", async () => {
  const id = await comment(alice, "Old words");
  await age("comments", id);
  const r = await edit(alice, id, "New words");
  assert.ok("error" in r, "refused");
  assert.equal(r.error, EDIT_REFUSED);
  const c = await listed(id);
  assert.equal(c?.body, "Old words", "unchanged");
  assert.equal(c?.edited, false);
  assert.equal(c?.editable, false, "the page's flag for the Edit button is off");
});
test.skip("CE2 (browser): the Edit button is gone after 24 hours — page rendering; the library's `editable` flag is tested above", () => {});

test("CE3: the 24 hours count from posting; an edit doesn't restart them", async () => {
  const id = await comment(alice, "v1");
  assert.ok("id" in (await edit(alice, id, "v2")), "edited while fresh");
  // Posted 25 hours ago, last edited just now.
  await age("comments", id);
  await q("update comments set edited_at = now() where id = $1", [id]);
  const r = await edit(alice, id, "v3");
  assert.ok("error" in r, "refused: the edit did not restart the window");
  assert.equal(r.error, EDIT_REFUSED);
  assert.equal((await listed(id))?.editable, false);
  // And the other way: posted 23 hours ago is still editable.
  const fresh = await comment(alice, "w1");
  await age("comments", fresh, 23);
  assert.ok("id" in (await edit(alice, fresh, "w2")), "23 hours after posting: still editable");
});

test("CE4: deleting after 24 hours stays allowed for the author and for Delete any comment", async () => {
  const mine = await comment(alice, "delete me later");
  const bobs = await comment(bob, "bob's old one");
  const another = await comment(bob, "bob's other");
  for (const id of [mine, bobs, another]) await age("comments", id, 72);
  assert.ok("reminderId" in (await deleteComment(await actor(alice), s.companyId, mine)), "the author deletes");
  assert.ok("reminderId" in (await deleteComment(await actor(olga), s.companyId, bobs)), "a Company Admin (Delete any comment) deletes");
  assert.ok("error" in (await deleteComment(await actor(alice), s.companyId, another)), "someone else without the permission still can't");
  assert.equal((await listed(mine))?.deleted ?? true, true);
  assert.equal((await listed(bobs))?.deleted ?? true, true);
});

test("CE5: a comment from before this change (no edit, older than 24 hours) is read-only", async () => {
  const [{ id: old }] = await q("insert into comments (company_id, reminder_id, author_id, body, created_at) values ($1, $2, $3, 'from last month', now() - interval '30 days') returning id", [
    s.companyId,
    reminderId,
    alice,
  ]);
  const [{ id: oldEdited }] = await q(
    "insert into comments (company_id, reminder_id, author_id, body, created_at, edited_at) values ($1, $2, $3, 'edited last week', now() - interval '30 days', now() - interval '1 hour') returning id",
    [s.companyId, reminderId, alice],
  );
  for (const id of [old, oldEdited]) {
    const r = await edit(alice, id, "changed");
    assert.ok("error" in r, "refused");
    assert.equal(r.error, EDIT_REFUSED);
    assert.equal((await listed(id))?.editable, false);
  }
});

// --- Attachment edit window ------------------------------------------------------------

test("AW1: the uploader removes their file within 24 hours (reminder form, comment edit)", async () => {
  const r = await makeReminder([txt("agenda.txt"), txt("keep.txt")]);
  const f = (await fileByName(r.id, "agenda.txt"))!;
  assert.equal(f.uploaded_by, olga);
  assert.equal(mayRemoveFile({ uploadedBy: f.uploaded_by, createdAt: f.created_at }, olga), true);
  assert.equal(await save(olga, r, [], [f.id]), null, "saved");
  assert.deepEqual(
    (await ownFiles(r.id)).map((x) => x.file_name),
    ["keep.txt"],
  );
  assert.deepEqual(
    (await listAttachments(s.companyId, r.id)).map((x) => x.fileName),
    ["keep.txt"],
  );

  const c = await comment(alice, "see attached", { files: [txt("draft.txt"), txt("other.txt")] });
  const draft = (await listed(c))!.files.find((x) => x.fileName === "draft.txt")!;
  assert.equal(draft.uploadedBy, alice);
  const e = await edit(alice, c, "see attached", { removeFileIds: [draft.id] });
  assert.ok("id" in e, `comment edit saved: ${JSON.stringify(e)}`);
  assert.deepEqual(
    (await listed(c))!.files.map((x) => x.fileName),
    ["other.txt"],
  );
});

test("AW2: replace = remove and add in one save; the new file starts its own 24 hours", async () => {
  const r = await makeReminder([txt("v1.txt")]);
  const old = (await fileByName(r.id, "v1.txt"))!;
  await age("attachments", old.id, 20); // still inside its 24 hours
  assert.equal(await save(olga, r, [txt("v2.txt")], [old.id]), null, "saved");
  const now = await ownFiles(r.id);
  assert.deepEqual(
    now.map((x) => x.file_name),
    ["v2.txt"],
  );
  assert.equal(now[0].uploaded_by, olga);
  assert.ok(isRecent(now[0].created_at), "the new file's 24 hours start now");
  assert.equal(inEditWindow(now[0].created_at, Date.now() + 23 * 3_600_000), true, "still removable 23 hours from now");

  const c = await comment(alice, "v1 attached", { files: [txt("c1.txt")] });
  const c1 = (await listed(c))!.files[0];
  const e = await edit(alice, c, "v2 attached", { files: [txt("c2.txt")], removeFileIds: [c1.id] });
  assert.ok("id" in e, JSON.stringify(e));
  const files = (await listed(c))!.files;
  assert.deepEqual(
    files.map((x) => x.fileName),
    ["c2.txt"],
  );
  assert.ok(isRecent(files[0].createdAt));
});

test("AW3: after 24 hours a file is locked for everyone; deleting the whole reminder or comment still removes it", async () => {
  const r = await makeReminder([txt("locked.txt")]);
  const f = (await fileByName(r.id, "locked.txt"))!;
  await age("attachments", f.id);
  const [{ created_at }] = await q("select created_at from attachments where id = $1", [f.id]);
  assert.equal(mayRemoveFile({ uploadedBy: olga, createdAt: created_at }, olga), false, "not even the uploader");
  assert.equal(mayRemoveFile({ uploadedBy: olga, createdAt: created_at }, adam), false);
  for (const who of [olga, adam]) {
    const err = await save(who, r, [], [f.id]);
    assert.equal(typeof err, "string", `a forged removal by ${who === olga ? "the uploader/creator" : "another admin"} is refused`);
    assert.ok(await fileByName(r.id, "locked.txt"), "still there");
  }
  assert.equal(await deleteReminder(await actor(olga), s.companyId, r.id), null, "the reminder is deleted");
  assert.equal(await downloadable(f.id), false, "gone with the reminder");

  const c = await comment(alice, "with a file", { files: [txt("old.txt")] });
  const cf = (await listed(c))!.files[0];
  await age("attachments", cf.id);
  const e = await edit(alice, c, "with a file", { removeFileIds: [cf.id] });
  assert.ok("error" in e, "removing an aged comment file is refused");
  assert.equal((await listed(c))!.files.length, 1);
  assert.ok("reminderId" in (await deleteComment(await actor(alice), s.companyId, c)));
  assert.ok(!(await thread()).some((x) => x.files.some((y) => y.id === cf.id)), "not listed after the comment is deleted");
  assert.equal(await downloadable(cf.id), false, "not downloadable after the comment is deleted");
});
test.skip("AW3 (browser): the edit form lists a locked file without the remove tick — page rendering; mayRemoveFile is tested above", () => {});

test("AW4: within 24 hours, someone else can't remove another person's file but can add their own", async () => {
  const r = await makeReminder([txt("olgas.txt")]);
  const f = (await fileByName(r.id, "olgas.txt"))!;
  assert.equal(mayRemoveFile({ uploadedBy: olga, createdAt: f.created_at }, adam), false);
  const err = await save(adam, r, [], [f.id]);
  assert.equal(typeof err, "string", "adam (an admin who may edit the reminder) can't remove olga's file");
  assert.ok(await fileByName(r.id, "olgas.txt"));
  assert.equal(await save(adam, r, [txt("adams.txt")]), null, "adam adds his own");
  const added = (await fileByName(r.id, "adams.txt"))!;
  assert.equal(added.uploaded_by, adam);
  assert.equal(await save(adam, r, [], [added.id]), null, "and may remove his own");
  assert.equal(await fileByName(r.id, "adams.txt"), undefined);
  assert.ok(await fileByName(r.id, "olgas.txt"), "olga's untouched");
});

test("AW5: copies (only this one, this and following, Duplicate) keep the uploader; the 24 hours restart", async () => {
  const series = await makeReminder([], olga, { title: "AW5 standup", daily: true, sendAt: new Date(Date.UTC(2031, 6, 1, 9)) });
  assert.equal(await save(adam, series, [txt("adam-notes.txt")]), null);
  const orig = (await fileByName(series.id, "adam-notes.txt"))!;
  await age("attachments", orig.id, 30);
  const check = async (copyId: string, label: string) => {
    const f = await fileByName(copyId, "adam-notes.txt");
    assert.ok(f, `${label}: the file is copied`);
    assert.notEqual(f.id, orig.id);
    assert.equal(f.uploaded_by, adam, `${label}: keeps its uploader`);
    assert.ok(isRecent(f.created_at), `${label}: the 24 hours restart on the copy (created_at ${f.created_at.toISOString()})`);
    assert.equal(mayRemoveFile({ uploadedBy: f.uploaded_by, createdAt: f.created_at }, adam), true, `${label}: adam may remove it on the copy`);
    assert.equal(mayRemoveFile({ uploadedBy: f.uploaded_by, createdAt: f.created_at }, olga), false, `${label}: olga still may not`);
  };

  const one = await detachOccurrence(await actor(olga), s.companyId, series.id, input({ title: "AW5 just this one", sendAt: new Date(Date.UTC(2031, 6, 1, 10)) }));
  assert.ok("id" in one, JSON.stringify(one));
  await check(one.id as string, "only this one");

  const moved = await moveEntry(await actor(olga), s.companyId, series.id, new Date(Date.UTC(2031, 6, 4, 9)), new Date(Date.UTC(2031, 6, 4, 11)), "following");
  assert.ok("id" in moved, JSON.stringify(moved));
  const [following] = await q("select id from reminders where company_id = $1 and title = 'AW5 standup' and id <> $2 and deleted_at is null order by created_at desc", [
    s.companyId,
    series.id,
  ]);
  assert.ok(following, "this and following made a new series");
  await check(following.id, "this and following");

  const dup = await duplicateReminder(await actor(olga), s.companyId, series.id, new Date(Date.UTC(2031, 7, 1, 9)));
  assert.ok("id" in dup, JSON.stringify(dup));
  await check(dup.id as string, "Duplicate");
});

test("AW6: the uploader has left the company: their files are locked at once", async (t) => {
  const leaver = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  await q(`update "user" set name = $2 where id = $1`, [leaver, name(leaver)]);
  const r = await makeReminder([txt("leavers.txt")], leaver);
  const f = (await fileByName(r.id, "leavers.txt"))!;
  const c = await comment(leaver, "my file", { files: [txt("leaver-comment.txt")] });
  const cf = (await listed(c))!.files[0];
  const leaverActor = await actor(leaver); // what a request made before leaving would carry
  assert.equal(await setActive(await actor(olga), s.companyId, leaver, false), null, "deactivated");

  await t.test("nobody else may remove it (within the 24 hours)", async () => {
    assert.equal(typeof (await save(olga, r, [], [f.id])), "string", "an admin's removal is refused");
    assert.equal(typeof (await save(adam, r, [], [f.id])), "string", "another admin's removal is refused");
    assert.ok(await fileByName(r.id, "leavers.txt"));
  });
  // The leaver can't sign in any more (session.ts redirects deactivated users),
  // so this is a request carrying their access from before they left.
  await t.test("the leaver's own removal, from a request made with their old access, is refused", async () => {
    const err = await updateReminder(leaverActor, s.companyId, r.id, input(r.o), [], [f.id]);
    assert.equal(typeof err, "string", "the leaver's own removal (inside 24 hours) is refused");
    assert.ok(await fileByName(r.id, "leavers.txt"));
    const e = await editComment(leaverActor, s.companyId, c, { body: "my file", mentionIds: [], removeFileIds: [cf.id] });
    assert.ok("error" in e, "the leaver's comment file removal is refused");
    assert.equal((await listed(c))!.files.length, 1);
  });
});

// --- Files on comments -------------------------------------------------------------------

test("CA1: files on comments and replies: same checks as reminder files, 10 MB each, up to 5 per comment", async () => {
  assert.equal(MAX_FILES_PER_COMMENT, 5);
  assert.ok(MAX_FILE_BYTES >= 10_000_000 && MAX_FILE_BYTES <= 10 * 1024 * 1024, `about 10 MB (got ${MAX_FILE_BYTES})`);
  refused("big.txt", new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61));
  ok("limit.txt", new Uint8Array(MAX_FILE_BYTES).fill(0x61));
  refused("evil.pdf", enc("MZ this is not a pdf"));

  const five = ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"].map((x) => txt(x));
  const top = await comment(alice, "five files", { files: five });
  assert.equal((await listed(top))!.files.length, 5);
  const six = await addComment(await actor(alice), s.companyId, reminderId, { body: "six", mentionIds: [], files: [...five, txt("6.txt")] });
  assert.ok("error" in six, "six files refused");
  const more = await edit(alice, top, "five files", { files: [txt("6.txt")] });
  assert.ok("error" in more, "adding a sixth on edit refused");
  assert.equal((await listed(top))!.files.length, 5);

  const reply = await comment(bob, "a reply with a file", { parentId: top, files: [ok("data.csv", enc("name,qty\nbolts,4\n"))] });
  const rr = await listed(reply);
  assert.deepEqual(
    rr!.files.map((x) => x.fileName),
    ["data.csv"],
  );
  assert.equal(rr!.files[0].uploadedBy, bob);
});
test.skip("CA1 (server action): uploads rate-limited like the reminder form's — limits() runs in the server action, which needs a request", () => {});

test("CA2: the files are listed for everyone who can see the reminder; downloading checks that too", async () => {
  const c = await comment(alice, "for the team", { files: [txt("team.txt")] });
  const f = (await listed(c))!.files[0];
  assert.equal(f.fileName, "team.txt");
  assert.equal(f.size, enc("notes for team.txt\n").length);
  assert.equal(await downloadable(f.id), true, "the route finds it with its bytes");
  const [{ reminder_id }] = await q("select reminder_id from attachments where id = $1", [f.id]);
  assert.equal(reminder_id, reminderId, "under the comment's reminder");
  const access = async (u: string) => reminderAccess(s.companyId, await actor(u), { id: reminderId, createdBy: creator });
  for (const u of [creator, alice, bob, olga]) assert.ok(await access(u), `${name(u)} may download`);
  assert.equal(await access(carol), null, "carol (can't see the reminder) may not");
});

test("CA3: a mentioned person's email carries the files in order within 20 MB, the rest named; Slack DM has the link only", async () => {
  const big = (fileName: string) => ok(fileName, new Uint8Array(9_000_000).fill(0x61));
  const files = [big("zeta.txt"), big("alpha.txt"), big("mid.txt")];
  const mails: Mail[] = [];
  const sl = fakeSlack();
  await setMutes(s.companyId, bob, []); // bob: mentions by email and Slack on
  await comment(alice, `@${name(bob)} the exports`, { files, mentionIds: [bob] }, { send: capture(mails), slackFetch: sl.f });
  const toBob = mails.filter((m) => m.to === emailOf(bob));
  assert.equal(toBob.length, 1, "one mention email");
  const m = toBob[0];
  assert.deepEqual(
    (m.attachments ?? []).map((a) => a.filename),
    ["zeta.txt", "alpha.txt"],
    "the first two (18 MB) in order",
  );
  const total = (m.attachments ?? []).reduce((t, a) => t + a.content.length, 0);
  assert.ok(total <= 20 * 1024 * 1024);
  const all = `${m.text}\n${JSON.stringify(m.links ?? [])}`;
  assert.match(all, /mid\.txt/, "the third is named");
  assert.match(all, /open it in NotifyHub/i);

  const posts = sl.calls.filter((c) => c.method === "chat.postMessage");
  assert.ok(posts.length >= 1, `a Slack DM was sent (calls: ${sl.calls.map((c) => c.method).join(", ")})`);
  assert.ok(!sl.calls.some((c) => c.method.startsWith("files.")), "no file uploads to Slack");
  assert.match(posts.map((p) => decodeURIComponent(p.body)).join("\n"), /https?:\/\//, "the DM has a link");
});

test("CA4: the creator's new-comment notice and people not mentioned get no files", async () => {
  await setMutes(s.companyId, creator, []); // the creator turns on "Someone commented on my reminder" by email
  const mails: Mail[] = [];
  await comment(alice, `@${name(bob)} see the file`, { files: [txt("only-for-thread.txt")], mentionIds: [bob] }, { send: capture(mails) });
  const toCreator = mails.filter((m) => m.to === emailOf(creator));
  assert.equal(toCreator.length, 1, "the creator hears about the comment");
  assert.deepEqual(toCreator[0].attachments ?? [], [], "without files");
  for (const m of mails.filter((x) => x.to !== emailOf(bob))) assert.deepEqual(m.attachments ?? [], [], `no files to ${m.to}`);
  assert.ok(!mails.some((m) => m.to === emailOf(alice) || m.to === emailOf(carol)), "nobody else is mailed");
  assert.equal(mails.find((m) => m.to === emailOf(bob))?.attachments?.length, 1, "only the mentioned person gets it");
  await setMutes(s.companyId, creator, ["comment:email", "comment:slack"]);
});

test("CA5: a deleted comment's files are no longer listed or downloadable", async () => {
  const c = await comment(alice, "temp", { files: [txt("temp.txt")] });
  await comment(bob, "a reply keeps the parent in the thread", { parentId: c });
  const f = (await listed(c))!.files[0];
  assert.equal(await downloadable(f.id), true);
  assert.ok("reminderId" in (await deleteComment(await actor(alice), s.companyId, c)));
  const after = await listed(c);
  assert.ok(after, "still shown as deleted (it has a reply)");
  assert.deepEqual(after.files, [], "no files listed");
  assert.equal(await downloadable(f.id), false, "not downloadable");
});

test("CA6: comment files don't go out with the reminder and don't count toward its 20 files", async () => {
  const sendAt = nextSend();
  const five = (p: string) => [1, 2, 3, 4, 5].map((i) => txt(`${p}${i}.txt`));
  const r = await makeReminder(five("a"), olga, { sendAt, title: "CA6" });
  assert.equal(await save(olga, r, five("b")), null);
  assert.equal(await save(olga, r, five("c")), null);
  await comment(olga, "comment files", { on: r.id, files: five("comment") });
  assert.equal(await save(olga, r, five("d")), null, "the 20th own file fits: comment files don't count");
  assert.equal((await ownFiles(r.id)).length, 20);
  assert.equal(typeof (await save(olga, r, [txt("e1.txt")])), "string", "a 21st own file is refused");

  const queued: string[] = [];
  await dispatchDue(async (x) => void queued.push(...x), s.companyId, new Date(sendAt.getTime() + 60_000));
  const mine = new Set((await q("select id from deliveries where reminder_id = $1", [r.id])).map((d) => d.id as string));
  const ids = queued.filter((d) => mine.has(d)); // earlier test reminders fall due too
  const mails: Mail[] = [];
  for (const d of ids) await deliverOne(d, capture(mails), fakeSlack().f);
  const toAlice = mails.filter((m) => m.to === emailOf(alice));
  assert.equal(toAlice.length, 1, "the reminder went to alice");
  const names = (toAlice[0].attachments ?? []).map((a) => a.filename);
  assert.ok(!names.some((x) => x.startsWith("comment")), `no comment files in the reminder (got ${names.join(", ")})`);
  assert.equal(names.length, 20, "its own 20 files");
});

test("CA7: a comment with only files and no text is allowed", async () => {
  const c = await comment(alice, "", { files: [txt("just-a-file.txt")] });
  const listedC = (await listed(c))!;
  assert.deepEqual(
    listedC.files.map((x) => x.fileName),
    ["just-a-file.txt"],
  );
  const none = await addComment(await actor(alice), s.companyId, reminderId, { body: "", mentionIds: [] });
  assert.ok("error" in none, "no text and no files is still refused");
});

// --- More file types ---------------------------------------------------------------------

test("FT1: .pages, .numbers, .key accepted when the bytes are an iWork 2013+ zip; iWork '09 refused", () => {
  for (const [ext, re] of [
    ["pages", /pages/i],
    ["numbers", /numbers/i],
    ["key", /keynote|key/i],
  ] as const) {
    const f = ok(`doc.${ext}`, IWORK);
    assert.match(f.contentType, re, `.${ext} type (got ${f.contentType})`);
    refused(`old.${ext}`, IWORK_09);
  }
});

test("FT2: .odt, .ods, .odp accepted when the OpenDocument type matches the extension", () => {
  const types = { odt: "text", ods: "spreadsheet", odp: "presentation" } as const;
  for (const [ext, type] of Object.entries(types)) {
    const f = ok(`file.${ext}`, ODF(type));
    assert.equal(f.contentType, `application/vnd.oasis.opendocument.${type}`);
    for (const otherExt of Object.keys(types)) if (otherExt !== ext) refused(`wrong.${otherExt}`, ODF(type));
  }
});

test("FT3: .rtf accepted when it starts with {\\rtf", () => {
  const f = ok("letter.rtf", enc("{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}}\\f0 Hello.}"));
  assert.match(f.contentType, /rtf/);
  refused("plain.rtf", enc("Hello, not RTF at all."));
});

test("FT4: .json accepted when it's UTF-8 text that parses as JSON", () => {
  for (const good of ['{"a":1,"b":[true,null]}', "[1, 2, 3]\n"]) assert.match(ok("data.json", enc(good)).contentType, /json/);
  refused("broken.json", enc('{"a": 1,'));
  refused("latin1.json", new Uint8Array([0x22, 0xe9, 0x22])); // "é" in Latin-1: not UTF-8
});

test("FT5: a renamed file is refused with the content-doesn't-match message", () => {
  for (const [fileName, bytes] of [
    ["report.odt", DOCX],
    ["slides.pages", PLAIN_ZIP],
    ["notes.json", enc("plain text, not json\n")],
  ] as const) {
    const err = refused(fileName, bytes);
    // The spec's wording, allowing the extension to be named: "its .odt extension".
    assert.match(err, /content doesn.t match its (\.\w+ )?extension/i, `${fileName}: ${err}`);
  }
  // Sanity: the .docx itself is still accepted as a .docx.
  ok("report.docx", DOCX);
});

test("FT6: a new-type file is stored with its real type (the route serves that, always as a download)", async () => {
  const files = [ok("a.odt", ODF("text")), ok("b.json", enc('{"x":1}')), ok("c.rtf", enc("{\\rtf1 hi}")), ok("d.pages", IWORK)];
  const r = await makeReminder(files);
  const rows = await ownFiles(r.id);
  for (const f of files) {
    const row = rows.find((x) => x.file_name === f.fileName);
    assert.ok(row, `${f.fileName} stored`);
    assert.equal(row.content_type, f.contentType, `${f.fileName} keeps its sniffed type`);
    assert.notEqual(row.content_type, "application/octet-stream");
    assert.ok(await downloadable(row.id));
  }
});
test.skip("FT6 (HTTP): Content-Disposition: attachment and the stored type on the response — needs a signed-in request", () => {});

test("FT7: the pickers' accept list and the allowed-types message list the new types", () => {
  const accept = ACCEPT.toLowerCase();
  for (const ext of [".pages", ".numbers", ".key", ".odt", ".ods", ".odp", ".rtf", ".json"]) assert.ok(accept.includes(ext), `ACCEPT has ${ext}: ${ACCEPT}`);
  for (const word of [/pages/i, /numbers/i, /keynote/i, /opendocument|odt/i, /rtf/i, /json/i]) assert.match(FILE_TYPES, word);
});
test.skip("FT7 (browser): the pickers and the message as shown on the page", () => {});
