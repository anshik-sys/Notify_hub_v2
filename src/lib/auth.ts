import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { sendMail } from "./mail";

if (!process.env.AUTH_DATABASE_URL) throw new Error("AUTH_DATABASE_URL is not set");

// Connects as notifyhub_auth. Sign-in looks users up by email before any
// company is known, so this role has an unscoped policy on the auth tables.
// Keep it inside src/lib: tenant data goes through withTenant() instead.
export const authDb = drizzle(process.env.AUTH_DATABASE_URL, { schema, casing: "snake_case" });

export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const auth = betterAuth({
  database: drizzleAdapter(authDb, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    // Not awaited: sign-up answers the same way for new and existing emails,
    // and waiting on SMTP only for new ones would leak which exist by timing.
    sendVerificationEmail: async ({ user, url }) => {
      sendMail(user.email, "Verify your email for NotifyHub", `Hi ${user.name},\n\nConfirm your email to finish signing up. The link expires in 1 hour.`, {
        label: "Verify email",
        url,
      }).catch((e) => console.error("verification email failed", e));
    },
  },
  socialProviders: {
    google: {
      enabled: googleEnabled,
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      mapProfileToUser: (profile) => {
        if (!profile.email_verified) throw new APIError("FORBIDDEN", { message: "Google email is not verified" });
        return {};
      },
    },
  },
  user: {
    additionalFields: {
      // Set once, by onboarding or invite acceptance. Never from client input.
      companyId: { type: "string", required: false, input: false },
    },
  },
  plugins: [nextCookies()],
});
