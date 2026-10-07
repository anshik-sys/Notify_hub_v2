import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "@/db";
import { encrypt } from "./crypto";
import { saveDigestSettings } from "./slack-installations";
import { seeder } from "./test-helpers";

const s = seeder();
const other = seeder();
let alice: string, stranger: string;

before(async () => {
  await s.company();
  await other.company();
  alice = await s.user();
  stranger = await other.user();
  await s.owner.query(
    "insert into slack_installations (company_id, team_id, team_name, bot_token_enc, bot_user_id) values ($1, $2, 'WS', $3, 'U')",
    [s.companyId, `T-${s.companyId}`, encrypt("xoxb")],
  );
});
after(async () => {
  await s.cleanup();
  await other.cleanup();
  await db.$client.end();
});

// (Channel validation calls Slack; it's exercised end to end against the fake.)
test("saveDigestSettings validation", async () => {
  const save = (over: object) => saveDigestSettings(s.companyId, { enabled: true, time: "09:00", channelIds: [], userIds: [alice], ...over });
  assert.match((await save({ time: "25:00" }))!, /time of day/);
  assert.match((await save({ userIds: [] }))!, /at least one channel or person/);
  assert.match((await save({ userIds: [stranger] }))!, /isn't in your company/);
  assert.equal(await save({}), null);
  assert.equal(await save({ enabled: false, userIds: [] }), null); // disabling with nobody is fine
  const [row] = (await s.owner.query("select digest_enabled, digest_user_ids from slack_installations where company_id = $1", [s.companyId])).rows;
  assert.deepEqual(row, { digest_enabled: false, digest_user_ids: [] });
  assert.match((await saveDigestSettings(other.companyId, { enabled: false, time: "09:00", channelIds: [], userIds: [] }))!, /isn't connected/);
});
