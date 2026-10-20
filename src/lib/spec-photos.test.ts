// Behaviour tests for docs/expected-behaviour.md section 8 (A1–A14, profile
// photos), written from the spec, not the code. A failure means the code or
// the spec is wrong.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { crc32 } from "node:zlib";
import { db } from "@/db";
import { authDb } from "./auth";
import { type Access, COMPANY_ADMIN_ROLE_ID, loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { exportPerson } from "./privacy";
import { seeder } from "./test-helpers";
import { erasePerson, PHOTO_MAX_BYTES, photoFile, photoUrls, removePhoto, setActive, setPhoto } from "./users";

const s = seeder();
const other = seeder();
type Actor = { id: string; access: Access };
let admin: Actor, boss: string, editor: Actor;
const q = async (sql: string, params: unknown[] = []) => (await s.owner.query(sql, params)).rows;
const actor = async (id: string) => ({ id, access: await loadAccess(s.companyId, id) });
const member = () => s.user({ roles: [MEMBER_ROLE_ID] });
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

// Real 2×2 images (made with sharp), plus the 1×1 PNG from the brief.
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
const same = (a: Buffer | undefined, b: Uint8Array) => !!a && Buffer.compare(a, Buffer.from(b)) === 0;
const urlOf = async (userId: string) => (await photoUrls(s.companyId)).get(userId);
const rowsFor = async (userId: string) => (await q("select content_type from user_photos where user_id = $1", [userId])).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await s.company();
  await other.company();
  admin = await actor(await s.user({ roles: [COMPANY_ADMIN_ROLE_ID, MEMBER_ROLE_ID] }));
  boss = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  const [{ id: editors }] = await q("insert into roles (company_id, name, permissions) values ($1, 'People editors', '{users.edit}') returning id", [
    s.companyId,
  ]);
  editor = await actor(await s.user({ roles: [MEMBER_ROLE_ID, editors] }));
});
after(async () => {
  await other.cleanup();
  await s.cleanup();
  await authDb.$client.end();
  await db.$client.end();
});

test("A1: PNG, JPEG, GIF and WebP up to 1 MB are saved and get a photo URL", async () => {
  assert.ok(PHOTO_MAX_BYTES >= 1_000_000 && PHOTO_MAX_BYTES <= 1_048_576, `limit is about 1 MB (got ${PHOTO_MAX_BYTES})`);
  const cases: [string, Uint8Array, string][] = [
    ["me.png", PNG, "image/png"],
    ["tiny.png", PNG_1x1, "image/png"],
    ["me.jpg", JPEG, "image/jpeg"],
    ["me.gif", GIF, "image/gif"],
    ["me.webp", WEBP, "image/webp"],
    ["big.png", pngOfSize(PHOTO_MAX_BYTES), "image/png"],
  ];
  for (const [name, bytes, type] of cases) {
    const id = await member();
    assert.equal(await setPhoto({ id }, s.companyId, name, bytes), null, `${name} accepted`);
    const f = await photoFile(s.companyId, id);
    assert.ok(f, `${name} stored`);
    assert.equal(f.contentType, type, `${name} content type`);
    assert.ok(same(f.data, bytes), `${name} bytes stored as uploaded`);
    assert.match((await urlOf(id)) ?? "", new RegExp(`^/api/avatar/${id}\\?v=\\d+$`), `${name} has a photo URL`);
  }
  // Someone without a photo has no URL (initials).
  assert.equal(await urlOf(await member()), undefined);
});

test("A2: over 1 MB, a PDF, an SVG and a text file renamed .png are refused; the old photo (or none) stays", async () => {
  const bad: [string, Uint8Array, RegExp][] = [
    ["huge.png", pngOfSize(PHOTO_MAX_BYTES + 1), /MB|large|big|size/i],
    ["doc.pdf", new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"), /image|PNG|JPEG|GIF|WebP|type|format/i],
    ["pic.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /image|PNG|JPEG|GIF|WebP|type|format|SVG/i],
    ["notes.png", new TextEncoder().encode("just some text pretending to be a picture\n"), /image|PNG|JPEG|GIF|WebP|type|format/i],
  ];
  const withPhoto = await member();
  assert.equal(await setPhoto({ id: withPhoto }, s.companyId, "me.png", PNG), null);
  const urlBefore = await urlOf(withPhoto);
  const none = await member();
  for (const [name, bytes, msg] of bad) {
    const r = await setPhoto({ id: withPhoto }, s.companyId, name, bytes);
    assert.equal(typeof r, "string", `${name} refused`);
    assert.match(r!, msg, `${name}: clear message (${r})`);
    const f = await photoFile(s.companyId, withPhoto);
    assert.ok(f && same(f.data, PNG) && f.contentType === "image/png", `${name}: old photo stays`);
    assert.equal(await urlOf(withPhoto), urlBefore, `${name}: URL unchanged`);

    assert.equal(typeof (await setPhoto({ id: none }, s.companyId, name, bytes)), "string", `${name} refused (no photo yet)`);
    assert.equal(await photoFile(s.companyId, none), null, `${name}: still initials`);
    assert.equal(await rowsFor(none), 0);
  }
});

test("A3: a second photo replaces the first; one row per person; the URL changes", async () => {
  const id = await member();
  assert.equal(await setPhoto({ id }, s.companyId, "one.png", PNG), null);
  const first = await urlOf(id);
  await sleep(20);
  assert.equal(await setPhoto({ id }, s.companyId, "two.jpg", JPEG), null);
  const f = await photoFile(s.companyId, id);
  assert.ok(f && same(f.data, JPEG) && f.contentType === "image/jpeg", "the new photo is served");
  assert.equal(await rowsFor(id), 1, "one photo per person");
  const second = await urlOf(id);
  assert.ok(second, "still has a URL");
  assert.notEqual(second, first, "the URL changes, so no stale cached image");
});

test("A4: removing your own photo brings back initials", async () => {
  const id = await member();
  assert.equal(await setPhoto({ id }, s.companyId, "me.png", PNG), null);
  assert.equal(await removePhoto(await actor(id), s.companyId, id), null);
  assert.equal(await photoFile(s.companyId, id), null);
  assert.equal(await urlOf(id), undefined, "no photo URL: initials");
  assert.equal(await rowsFor(id), 0, "nothing left stored");
});

test.skip("A5: the photo shows wherever initials show (browser: Team, group members, Discussion, sidebar card and top bar are screens)");

test.skip("A6: another company's member or a signed-out visitor gets 404 / sign-in from /api/avatar/<id> (browser: needs signed-in HTTP requests to the route)");

test("A6 (lib): photoFile and photoUrls never return another company's photo", async () => {
  const stranger = await other.user({ roles: [MEMBER_ROLE_ID] });
  assert.equal(await setPhoto({ id: stranger }, other.companyId, "me.png", PNG), null);
  assert.ok(await photoFile(other.companyId, stranger), "control: stored in their own company");
  assert.equal(await photoFile(s.companyId, stranger), null, "not served through our company");
  assert.equal((await photoUrls(s.companyId)).get(stranger), undefined, "not in our company's URLs");
});

test.skip("A7: a malformed or unknown user id in /api/avatar/<id> gives 404 (browser: route needs a signed-in HTTP request)");

test("A7 (lib): photoFile for a malformed or unknown id is null, not an error", async () => {
  for (const id of ["not-a-real-id", "", "x".repeat(500), "'; drop table user_photos; --", "00000000-0000-4000-8000-00000000dead"])
    assert.equal(await photoFile(s.companyId, id), null, JSON.stringify(id.slice(0, 20)));
});

test("A8: a users.edit person removes a member's photo, can't upload one for them, and is refused for someone above", async () => {
  const m = await member();
  assert.equal(await setPhoto({ id: m }, s.companyId, "me.png", PNG), null);
  assert.equal(await removePhoto(editor, s.companyId, m), null, "allowed for a member");
  assert.equal(await photoFile(s.companyId, m), null);

  // setPhoto only ever sets the actor's own photo.
  const m2 = await member();
  assert.equal(await setPhoto(editor, s.companyId, "for-them.gif", GIF), null);
  assert.equal(await photoFile(s.companyId, m2), null, "nothing uploaded for the member");
  assert.ok(same((await photoFile(s.companyId, editor.id))?.data, GIF), "it went on the editor's own profile");

  // Someone above (a Company Admin): refused, photo stays.
  assert.equal(await setPhoto({ id: boss }, s.companyId, "boss.png", PNG), null);
  const r = await removePhoto(editor, s.companyId, boss);
  assert.equal(typeof r, "string", "refused for an admin");
  assert.ok(same((await photoFile(s.companyId, boss))?.data, PNG), "admin's photo stays");
  // An admin may remove another admin's photo.
  assert.equal(await removePhoto(admin, s.companyId, boss), null);
  assert.equal(await photoFile(s.companyId, boss), null);
});

test.skip("A9: a plain member removing someone else's photo is refused (browser: the users.edit check is in the server action, which needs a signed-in request)");

test("A9 (lib): a plain member can't remove an admin's photo (someone above them), nor another company's", async () => {
  const m = await actor(await member());
  const a = await s.user({ roles: [COMPANY_ADMIN_ROLE_ID] });
  assert.equal(await setPhoto({ id: a }, s.companyId, "a.png", PNG), null);
  assert.equal(typeof (await removePhoto(m, s.companyId, a)), "string", "refused");
  assert.ok(same((await photoFile(s.companyId, a))?.data, PNG), "photo stays");

  const stranger = await other.user({ roles: [MEMBER_ROLE_ID] });
  assert.equal(await setPhoto({ id: stranger }, other.companyId, "s.png", PNG), null);
  assert.equal(typeof (await removePhoto(admin, s.companyId, stranger)), "string", "another company's person: refused");
  assert.ok(same((await photoFile(other.companyId, stranger))?.data, PNG), "their photo stays");
});

test("A10: a deactivated person's photo still shows", async () => {
  const id = await member();
  assert.equal(await setPhoto({ id }, s.companyId, "me.webp", WEBP), null);
  const url = await urlOf(id);
  assert.equal(await setActive(admin, s.companyId, id, false), null);
  assert.ok(same((await photoFile(s.companyId, id))?.data, WEBP), "still served");
  assert.equal(await urlOf(id), url, "still has its URL");
});

test("A11: erasing a person deletes their photo; nothing left in storage", async () => {
  const id = await member();
  assert.equal(await setPhoto({ id }, s.companyId, "me.png", PNG), null);
  assert.equal(await setActive(admin, s.companyId, id, false), null);
  assert.equal(await erasePerson(admin, s.companyId, id), null);
  assert.equal(await photoFile(s.companyId, id), null);
  assert.equal(await urlOf(id), undefined, "back to initials");
  assert.equal(await rowsFor(id), 0, "no user_photos row");
});

test("A12: the data export includes the photo: type, size, uploaded at and the image as base64", async () => {
  const id = await member();
  assert.equal(await setPhoto({ id }, s.companyId, "me.jpg", JPEG), null);
  const stored = await photoFile(s.companyId, id);
  assert.ok(stored);
  const exp = (await exportPerson(s.companyId, id)) as Record<string, unknown>;
  assert.ok("photo" in exp && exp.photo, "export has a photo");
  const photo = JSON.parse(JSON.stringify(exp.photo)) as Record<string, unknown>;
  const values = Object.values(photo);
  assert.ok(values.includes("image/jpeg"), `type included: ${JSON.stringify(photo).slice(0, 200)}`);
  assert.ok(values.includes(JPEG.length), "size included");
  // Base64 (line-wrapped MIME base64 counts too) or a data: URI carrying it.
  const isImage = (v: unknown) =>
    typeof v === "string" &&
    /^(data:image\/jpeg;base64,)?[A-Za-z0-9+/=\s]+$/.test(v) &&
    Buffer.compare(Buffer.from(v.replace(/^data:[^,]*,/, ""), "base64"), Buffer.from(JPEG)) === 0;
  assert.ok(
    values.some(isImage),
    `image included as base64; got keys ${Object.keys(photo).join(", ")}: ${JSON.stringify(photo, (_k, v) => (typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…(${v.length})` : v))}`,
  );
  assert.ok(
    values.some((v) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && Math.abs(Date.parse(v) - stored.updatedAt.getTime()) < 1000),
    "uploaded-at included",
  );

  const none = await member();
  const exp2 = (await exportPerson(s.companyId, none)) as Record<string, unknown>;
  assert.ok("photo" in exp2, "photo key present");
  assert.equal(exp2.photo, null, "null when there is no photo");
});

test.skip("A13: more than 30 uploads in an hour are refused ('too many') (browser: the rate limit is applied in the server action, keyed by the signed-in account and client IP)");

test.skip("A14: the audit log has a 'Photo changed/removed' row with no image bytes (browser: the actor comes from the signed-in request, so lib calls record nothing)");
