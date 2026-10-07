import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReminderEmail } from "./email-render";

const base = { title: "Pay <rent>", description: "Line 1\nLine 2 & more", links: [{ label: "Doc", url: "https://x.test/?a=1&b=2" }], senderName: "HR", appUrl: "https://app.test/r/1" };

test("renderReminderEmail", () => {
  const plain = renderReminderEmail(base);
  assert.equal(plain.subject, "Pay <rent>");
  assert.equal(plain.fromName, "HR via NotifyHub");
  assert.deepEqual(plain.links.at(-1), { label: "Open in NotifyHub", url: "https://app.test/r/1" });
  assert.ok(plain.html.includes("Line 1<br>Line 2 &amp; more"));
  assert.ok(plain.html.includes('href="https://x.test/?a=1&amp;b=2"'));
  assert.ok(!plain.html.includes("<rent>"));

  const task = renderReminderEmail({ ...base, due: "8 Oct, 10:00 (UTC)", tooBig: ["big.zip"], test: true });
  assert.equal(task.subject, "[Test] Task: Pay <rent>");
  assert.match(task.text, /^This is a test, sent only to you\./);
  assert.match(task.text, /Not attached \(too large for email\): big\.zip/);
  assert.match(task.text, /Due 8 Oct, 10:00 \(UTC\)\.$/);
  assert.equal(task.links.at(-1)!.label, "Mark it done in NotifyHub");
});
