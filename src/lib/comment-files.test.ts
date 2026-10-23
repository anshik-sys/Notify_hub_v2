// PRD 14.6: edit windows, files on comments, more file types.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { authDb } from "./auth";
import { checkFile } from "./attachments";
import { addComment, deleteComment, editComment, listComments } from "./comments";
import { COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { createReminder, formToRaw, listAttachments, updateReminder, validateInput } from "./reminders";
import { seeder } from "./test-helpers";

const s = seeder();
let admin: string, alice: string, bob: string;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, name: `N-${id.slice(0, 6)}`, email: `${id}@${s.domain}`, access: await loadAccess(s.companyId, id) });
const file = (name: string, text: string) => {
  const r = checkFile(name, new TextEncoder().encode(text));
  if ("error" in r) throw new Error(r.error);
  return r.file;
};
const zip = (inside: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`\0\0\0\0${inside}\0\0`, "latin1")]);
const DAY = 86_400_000;
const later = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 16);

// A reminder to alice and bob made through the form.
function input() {
  const fd = new FormData();
  for (const [k, v] of [
    ["title", "Policy"], ["description", ""], ["senderName", ""], ["users", alice], ["users", bob], ["emails", ""], ["when", "later"], ["sendAt", later],
    ["repeat", "none"], ["every", "1"], ["unit", "week"], ["monthlyBy", "day"], ["ends", "never"], ["until", ""], ["count", ""], ["channels", "email"], ["tags", ""], ["due", ""],
  ]) fd.append(k, v);
  const p = validateInput(formToRaw(fd), "UTC", "Alerts | Test Co", new Date(), []);
  assert.equal(p.error, undefined);
  return p.input!;
}

before(async () => {
  await s.company();
  admin = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  [alice, bob] = [await s.user({ roles: [MEMBER_ROLE_ID] }), await s.user({ roles: [MEMBER_ROLE_ID] })];
  for (const u of [admin, alice, bob]) await q(`update "user" set name = $2 where id = $1`, [u, `N-${u.slice(0, 6)}`]);
});
after(async () => {
  await q("delete from comments where company_id = $1", [s.companyId]);
  await s.cleanup();
  await Promise.all([authDb.$client.end(), db.$client.end()]);
});

test("new types are checked by their bytes", () => {
  const ok = (name: string, bytes: Uint8Array) => "file" in checkFile(name, bytes);
  assert.ok(ok("a.odt", zip("mimetypeapplication/vnd.oasis.opendocument.text")));
  assert.ok(ok("a.ods", zip("mimetypeapplication/vnd.oasis.opendocument.spreadsheet")));
  assert.ok(!ok("a.ods", zip("mimetypeapplication/vnd.oasis.opendocument.text")));
  assert.ok(ok("a.pages", zip("Index/Document.iwa")));
  assert.ok(ok("a.key", zip("Index/Document.iwa")));
  assert.ok(!ok("a.pages", zip("index.xml"))); // iWork '09
  assert.ok(!ok("a.odt", zip("[Content_Types].xml word/document.xml"))); // a .docx
  assert.ok(ok("a.rtf", new TextEncoder().encode("{\\rtf1 hello}")));
  assert.ok(!ok("a.rtf", new TextEncoder().encode("hello")));
  assert.ok(ok("a.json", new TextEncoder().encode('{"a": [1, 2]}')));
  assert.ok(!ok("a.json", new TextEncoder().encode("{a: 1}")));
});

test("a reminder's files: only the uploader removes them, for 24 hours", async () => {
  const made = await createReminder(await actor(alice), s.companyId, input(), [file("a.txt", "one")]);
  assert.ok("id" in made);
  const [f] = await listAttachments(s.companyId, made.id);
  assert.match((await updateReminder(await actor(admin), s.companyId, made.id, input(), [], [f.id])) ?? "", /files you uploaded/);
  await q("update attachments set created_at = now() - interval '25 hours' where id = $1", [f.id]);
  assert.match((await updateReminder(await actor(alice), s.companyId, made.id, input(), [], [f.id])) ?? "", /24 hours/);
  await q("update attachments set created_at = now() where id = $1", [f.id]);
  assert.equal(await updateReminder(await actor(alice), s.companyId, made.id, input(), [], [f.id]), null);
  assert.equal((await listAttachments(s.companyId, made.id)).length, 0);
});

test("comments: files, mention email carries them, edit window, delete removes them", async () => {
  const made = await createReminder(await actor(admin), s.companyId, input());
  assert.ok("id" in made);
  const id = made.id;
  const mails: { to: string; attachments?: unknown[] }[] = [];
  const send = (async (m: (typeof mails)[number]) => void mails.push(m)) as never;
  const me = await actor(alice);
  await q("insert into reminder_shares (reminder_id, company_id, kind, ref) values ($1, $2, 'company', null)", [id, s.companyId]); // so alice can open it
  const c = await addComment(await actor(admin), s.companyId, id, { body: `@${me.name} see attached`, mentionIds: [alice], files: [file("notes.txt", "hi")] }, { send });
  assert.ok("id" in c, JSON.stringify(c));
  const mail = mails.find((m) => m.to === me.email);
  assert.equal(mail?.attachments?.length, 1);
  const [thread] = await listComments(s.companyId, id);
  assert.deepEqual(thread.files.map((f) => f.fileName), ["notes.txt"]);
  assert.equal((await listAttachments(s.companyId, id)).length, 0, "not the reminder's own");
  const filesOnly = await addComment(await actor(admin), s.companyId, id, { body: "", mentionIds: [], files: [file("b.txt", "x")] });
  assert.ok("id" in filesOnly);

  await q("update comments set created_at = now() - interval '25 hours' where id = $1", [c.id]);
  assert.match(JSON.stringify(await editComment(await actor(admin), s.companyId, c.id, { body: "changed", mentionIds: [] })), /24 hours/);
  assert.ok(!("error" in (await deleteComment(await actor(admin), s.companyId, c.id))));
  assert.equal((await q("select 1 from attachments where comment_id = $1", [c.id])).length, 0);
});
