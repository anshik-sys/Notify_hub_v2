import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
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
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // PRD 3.2: single use (Better Auth deletes the token), 1 hour, and a reset
    // signs out every session.
    resetPasswordTokenExpiresIn: 3600,
    revokeSessionsOnPasswordReset: true,
    // Not awaited, like verification: the response must not reveal by timing
    // whether the account exists.
    sendResetPassword: async ({ user, url }) => {
      sendMail({
        to: user.email,
        subject: "Reset your NotifyHub password",
        text: `Hi ${user.name},\n\nSomeone asked to reset your password. If it was you, use the link below within 1 hour. If not, ignore this email.`,
        links: [{ label: "Reset password", url }],
      }).catch((e) => console.error("reset email failed", e));
    },
  },
  emailVerification: {
    // Off: /sign-up sends it explicitly, so accepting an invite (which proves the
    // mailbox by itself) doesn't also send a verification email.
    sendOnSignUp: false,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    // Not awaited: sign-up answers the same way for new and existing emails,
    // and waiting on SMTP only for new ones would leak which exist by timing.
    sendVerificationEmail: async ({ user, url }) => {
      sendMail({
        to: user.email,
        subject: "Verify your email for NotifyHub",
        text: `Hi ${user.name},\n\nConfirm your email to finish signing up. The link expires in 1 hour.`,
        links: [{ label: "Verify email", url }],
      }).catch((e) => console.error("verification email failed", e));
    },
  },
  // PRD 11.1: reset tokens and 2FA challenge ids are stored only as hashes.
  verification: { storeIdentifier: "hashed" },
  // Its own HTTP routes (/api/auth/*): always on, in Postgres so every
  // instance shares the counts. Our server actions call auth.api directly,
  // which skips this; they use src/lib/rate-limit.ts instead.
  rateLimit: { enabled: true, storage: "database", modelName: "rateLimit" },
  advanced: { ipAddress: { ipAddressHeaders: [process.env.CLIENT_IP_HEADER || "x-forwarded-for"] } },
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
      deactivatedAt: { type: "date", required: false, input: false },
      // Set by our profile action only (src/lib/account.ts).
      timeZone: { type: "string", required: false, input: false },
      erasedAt: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Every sign-in method creates a session here, so this blocks them all.
        before: async (session) => {
          const [u] = await authDb
            .select({ deactivatedAt: schema.user.deactivatedAt })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId));
          if (u?.deactivatedAt) throw new APIError("FORBIDDEN", { message: "This account has been deactivated." });
        },
      },
    },
  },
  // twoFactor: TOTP + backup codes (PRD 3.1). It challenges email/password
  // sign-ins only; Google sign-in relies on Google's own 2-step.
  // nextCookies must stay last.
  plugins: [twoFactor({ issuer: "NotifyHub" }), nextCookies()],
});
