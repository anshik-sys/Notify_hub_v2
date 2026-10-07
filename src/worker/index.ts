import { PgBoss } from "pg-boss";

// Long-running process, deployed separately from the web app. Connects as the
// table owner because the scheduler scans due reminders across all tenants.
const url = process.env.OWNER_DATABASE_URL;
if (!url) throw new Error("OWNER_DATABASE_URL is not set");

const boss = new PgBoss(url);
boss.on("error", console.error);
await boss.start();

await boss.createQueue("tick");
await boss.schedule("tick", "* * * * *");
// ponytail: tick only logs until the reminders table and delivery exist
await boss.work("tick", async () => console.log("tick", new Date().toISOString()));

console.log("worker started");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await boss.stop();
    process.exit(0);
  });
}
