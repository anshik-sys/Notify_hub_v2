import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { ownerUrl } from "./db";
import { deliverOne, dispatchDue, MAX_ATTEMPTS, sweep } from "./delivery";

// Long-running process, deployed separately from the web app.
// Sends due reminders: immediately when the web app NOTIFYs `reminders_due`,
// and every minute regardless (the safety net if a notification is missed).

// useListenNotify + queue notify: a new deliver job wakes a worker at once.
const boss = new PgBoss({ connectionString: ownerUrl, useListenNotify: true });
boss.on("error", console.error);
await boss.start();
await boss.createQueue("tick");
await boss.createQueue("deliver", { notify: true });
await boss.updateQueue("deliver", { notify: true }); // createQueue leaves an existing queue as it was

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
      const n = await dispatchDue(enqueue).catch((e) => (console.error("dispatch failed", e), 0));
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

await boss.schedule("tick", "* * * * *");
await boss.work("tick", async () => {
  await enqueue(await sweep());
  await dispatch();
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
console.log("worker started");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await listener.end().catch(() => {});
    await boss.stop();
    process.exit(0);
  });
}
