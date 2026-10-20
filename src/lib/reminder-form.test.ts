import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { loadAccess, MEMBER_ROLE_ID } from "./permissions";
import { createReminder, formToRaw, getReminder, validateInput } from "./reminders";
import { seeder } from "./test-helpers";

// The New/Edit reminder form, end to end below the browser: a post shaped
// like the real form's -> formToRaw -> validateInput -> createReminder.
const s = seeder();
let alice: string, ops: string;
const later = new Date(Date.now() + 2 * 86_400_000); // two days ahead, so a live worker won't send it
const local = (d: Date) => d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM", as <input type=datetime-local> posts (company zone is UTC)

// What the browser sends for a form. Unticked checkboxes are simply absent.
const post = (fields: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return fd;
};
const baseFields = (): [string, string][] => [
  ["title", "Submit expense reports"],
  ["description", "Receipts attached, please."],
  ["senderName", ""],
  ["linkLabel", "Policy"],
  ["linkUrl", "https://example.com/policy"],
  ["departments", ops],
  ["emails", ""],
  ["when", "later"],
  ["sendAt", local(later)],
  ["repeat", "none"],
  ["every", "1"],
  ["unit", "week"],
  ["monthlyBy", "day"],
  ["ends", "never"],
  ["until", ""],
  ["count", ""],
  ["channels", "email"],
  ["tags", "finance, q3"],
  ["due", ""],
];
const save = async (fd: FormData) => {
  const parsed = validateInput(formToRaw(fd), "UTC", "Alerts | Test Co");
  if (parsed.error !== undefined) return { error: parsed.error };
  return createReminder({ id: alice, access: await loadAccess(s.companyId, alice) }, s.companyId, parsed.input);
};

before(async () => {
  await s.company();
  alice = await s.user({ roles: [MEMBER_ROLE_ID] });
  ({ rows: [{ id: ops }] } = await s.owner.query("insert into departments (company_id, name) values ($1, 'Ops') returning id", [s.companyId]));
  await s.owner.query("insert into department_members values ($1, $2, $3, false)", [s.companyId, ops, alice]);
});
after(async () => {
  await s.cleanup();
  await db.$client.end();
});

test("every field the server reads exists in the form (catches a renamed field)", () => {
  const read = new Set<string>();
  const spy = new Proxy(new FormData(), {
    get: (t, p) => (p === "get" || p === "getAll" ? (k: string) => (read.add(k), (t[p] as (k: string) => unknown).call(t, k)) : Reflect.get(t, p)),
  });
  formToRaw(spy);
  const form = ["reminder-form.tsx", "people-picker.tsx"]
    .map((f) => readFileSync(new URL(`../app/(app)/reminders/${f}`, import.meta.url), "utf8"))
    .join("\n");
  const inForm = new Set([...form.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]));
  assert.ok(read.size > 20, "formToRaw reads the form's fields");
  assert.deepEqual([...read].filter((k) => !inForm.has(k)), [], "fields the server reads but the form never sends");
});

test("a task to my department: saved with its due time, targets, tags and link", async () => {
  const due = new Date(later.getTime() + 3 * 3_600_000);
  const fd = post([...baseFields().filter(([k]) => k !== "due"), ["kind", "task"], ["due", local(due)]]);
  const r = await save(fd);
  assert.ok("id" in r, JSON.stringify(r));
  const saved = (await getReminder(s.companyId, r.id))!;
  assert.equal(saved.status, "scheduled"); // own department: no approval
  assert.equal(saved.isTask, true);
  assert.equal(saved.dueAfterMinutes, 180);
  assert.equal(saved.sendAt.toISOString().slice(0, 16), local(later));
  assert.deepEqual(saved.targets.map((t) => [t.kind, t.ref]), [["department", ops]]);
  assert.deepEqual(saved.tags, ["finance", "q3"]);
  assert.deepEqual(saved.links, [{ label: "Policy", url: "https://example.com/policy" }]);
  assert.deepEqual(saved.channels, ["email"]);
});

test("an announcement (task unticked) ignores a leftover due date", async () => {
  const r = await save(post([...baseFields().filter(([k]) => k !== "due"), ["due", local(later)]]));
  assert.ok("id" in r);
  const saved = (await getReminder(s.companyId, r.id))!;
  assert.equal(saved.isTask, false);
  assert.equal(saved.dueAfterMinutes, null);
});

test("the form's mistakes come back as messages, and nothing is saved", async () => {
  const count = async () => (await s.owner.query("select count(*)::int as n from reminders where company_id = $1", [s.companyId])).rows[0].n;
  const before = await count();
  const cases: [string, [string, string][], RegExp][] = [
    ["no title", baseFields().map(([k, v]) => [k, k === "title" ? "" : v]), /title/i],
    ["a task with no due time", [...baseFields(), ["kind", "task"]], /due/i],
    ["no recipients", baseFields().filter(([k]) => k !== "departments"), /recipient|who/i],
    ["no channel", baseFields().filter(([k]) => k !== "channels"), /channel/i],
  ];
  for (const [name, fields, message] of cases) {
    const r = await save(post(fields));
    assert.ok("error" in r && message.test(r.error), `${name}: ${JSON.stringify(r)}`);
  }
  assert.equal(await count(), before);
});
