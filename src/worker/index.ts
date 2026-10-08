import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { sql } from "drizzle-orm";
import { checkEnvironment } from "@/lib/env-check";
import { ownerDb, ownerUrl } from "./db";
import { claimDigests, digestOne } from "./digest";
import { runRetention } from "./retention";
import { volumeAlerts } from "./volume-alert";
import { claimFollowUps, claimSnoozes, deliverOne, dispatchDue, dispatchManual, followUpOne, MAX_ATTEMPTS, snoozeOne, sweep } from "./delivery";

// Long-running process, deployed separately from the web app.
// Sends due reminders: immediately when the web app NOTIFYs `reminders_due`,
// and every minute regardless (the safety net if a notification is missed).

await checkEnvironment("worker");

// useListenNotify + queue notify: a new deliver job wakes a worker at once.
const boss = new PgBoss({ connectionString: ownerUrl, useListenNotify: true });
boss.on("error", console.error);
await boss.start();
await boss.createQueue("tick");
await boss.createQueue("deliver", { notify: true });
await boss.updateQueue("deliver", { notify: true }); // createQueue leaves an existing queue as it was
await boss.createQueue("followup", { notify: true });
await boss.createQueue("snooze", { notify: true });
await boss.createQueue("digest", { notify: true });
await boss.createQueue("retention");
await boss.createQueue("volume");

const enqueue = async (ids: string[]) => {
  for (const deliveryId of ids)
    // singletonKey: at most one live job per delivery. The claim in deliverOne
    // is what actually guarantees one send.
    await boss.send("deliver", { deliveryId }, { singletonKey: deliveryId, retryLimit: MAX_ATTEMPTS - 1, retryDelay: 10, retryBackoff: true });
};

// One dispatch at a time in this process; a request during a run triggers one more run.
let running: Promise<void> | null = null;
let again = false;
function dispatch() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      const n =
        (await dispatchDue(enqueue).catch((e) => (console.error("dispatch failed", e), 0))) +
        (await dispatchManual(enqueue).catch((e) => (console.error("send-now dispatch failed", e), 0)));
      if (n) console.log(`dispatched ${n} reminder(s)`);
    } while (again);
    running = null;
  })();
  return running;
}

// ponytail: 10 parallel sends per worker process; raise with SES's per-second quota
await boss.work<{ deliveryId: string }>("deliver", { localConcurrency: 10 }, async ([job]) => {
  const result = await deliverOne(job.data.deliveryId);
  console.log(`delivery ${job.data.deliveryId}: ${result}`);
});

await boss.work<{ assignmentId: string }>("followup", { localConcurrency: 10 }, async ([job]) => {
  console.log(`follow-up ${job.data.assignmentId}: ${await followUpOne(job.data.assignmentId)}`);
});

await boss.work<{ assignmentId: string }>("snooze", { localConcurrency: 10 }, async ([job]) => {
  console.log(`snooze ${job.data.assignmentId}: ${await snoozeOne(job.data.assignmentId)}`);
});

await boss.work<{ companyId: string }>("digest", async ([job]) => {
  console.log(`digest ${job.data.companyId}:`, await digestOne(job.data.companyId));
});

// Data retention, nightly at 03:00 UTC (PRD 9.1).
await boss.schedule("retention", "0 3 * * *");
await boss.work("retention", async () => runRetention());

// Platform volume alert, hourly (PRD 9.2).
await boss.schedule("volume", "5 * * * *");
await boss.work("volume", async () => void (await volumeAlerts()));

await boss.schedule("tick", "* * * * *");
// /api/health reports the worker down if this is older than 3 minutes.
const heartbeat = () =>
  ownerDb.execute(sql`insert into worker_heartbeat (id, at) values (1, now()) on conflict (id) do update set at = now()`);

await boss.work("tick", async () => {
  await heartbeat();
  await ownerDb.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`).catch(console.error);
  await enqueue(await sweep());
  await dispatch();
  // Claimed once per delivery per local day; the job only sends.
  for (const assignmentId of await claimFollowUps())
    await boss.send("followup", { assignmentId }, { retryLimit: 3, retryDelay: 30, retryBackoff: true });
  // Claimed (cleared) once; a failed re-send isn't retried, to never DM twice.
  for (const assignmentId of await claimSnoozes()) await boss.send("snooze", { assignmentId }, { retryLimit: 0 });
  // One digest per company per local day (claimed); no retries, never twice.
  for (const companyId of await claimDigests()) await boss.send("digest", { companyId }, { retryLimit: 0 });
});

// LISTEN needs a plain session connection (not a transaction-mode pooler).
const listener = new Client({ connectionString: ownerUrl });
await listener.connect();
listener.on("notification", () => void dispatch());
listener.on("error", (e) => {
  console.error("listener error, exiting so the process manager restarts us", e);
  process.exit(1);
});
await listener.query("LISTEN reminders_due");

await dispatch(); // anything that came due while the worker was down
await heartbeat();
console.log("worker started");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await listener.end().catch(() => {});
    await boss.stop();
    process.exit(0);
  });
}
