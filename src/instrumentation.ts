// Runs once when the Next server starts: stop on unsafe configuration (PRD 11.2).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkEnvironment } = await import("./lib/env-check");
    await checkEnvironment("web");
  }
}
