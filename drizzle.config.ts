import { defineConfig } from "drizzle-kit";

// Migrations run as the table owner, never as the RLS-restricted app role.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: { url: process.env.OWNER_DATABASE_URL! },
});
