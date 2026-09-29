import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { Resend } from "resend";
import {
  checkActiveMobileToken,
  revokeMobileToken,
  signMobileToken,
  verifyActiveMobileToken,
} from "../lib/auth";
import { consumeOtpRateLimit, otpRateLimitClientIp } from "../lib/otpRateLimit";
import { z } from "zod/v4";
import { createHash, randomBytes, randomInt } from "crypto";
import { db } from "../lib/db";
import {
  createAppleLinkToken,
  verifyAppleIdentityToken,
  verifyAppleLinkToken,
} from "../lib/appleIdentity";

const router = Router();
const MOBILE_WEB_TICKET_TTL_SECONDS = 60;
const MOBILE_WEB_SIGN_IN_URL = "https://os.presentail.com/sign-in";

function setNoStore(res: Parameters<Parameters<typeof router.post>[1]>[1]): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

router.post("/mobile/auth/logout", async (req, res) => {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearer || !(await verifyActiveMobileToken(bearer))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    await revokeMobileToken(bearer);
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Mobile auth logout error");
    res.status(500).json({ error: "Authentication service error" });
  }
});

// ─── Session validation ──────────────────────────────────────────────────────
// Lets the mobile app check whether a stored token is still valid at startup.
// Confirms both the token signature and its backing Clerk session.
router.get("/mobile/auth/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const result = bearer
    ? await checkActiveMobileToken(bearer)
    : { status: "invalid" as const };
  if (result.status === "unavailable") {
    res.status(503).json({ error: "Authentication service unavailable" });
    return;
  }
  if (result.status === "invalid") {
    // Marker header lets the app distinguish "this token is definitively
    // invalid" from generic 401s (e.g. an older server without this route),
    // so it never signs users out based on an ambiguous response.
    res.setHeader("X-Mobile-Auth", "invalid");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const mobile = result.mobile;
  res.json({ userId: mobile.userId, email: mobile.email });
});

// Exchanges an active, revocable native session for a fresh, single-use Clerk
// ticket. The ticket is deliberately returned only inside the trusted WebView
// bootstrap URL and must never be persisted by the mobile client.
router.post("/mobile/auth/web-session", async (req, res) => {
  setNoStore(res);
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const result = bearer
    ? await checkActiveMobileToken(bearer)
    : { status: "invalid" as const };
  if (result.status === "unavailable") {
    res.status(503).json({ error: "Authentication service unavailable" });
    return;
  }
  if (result.status === "invalid") {
    res.setHeader("X-Mobile-Auth", "invalid");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const mobile = result.mobile;

  try {
    const signInToken = await clerkClient.signInTokens.createSignInToken({
      userId: mobile.userId,
      expiresInSeconds: MOBILE_WEB_TICKET_TTL_SECONDS,
    });
    const url = new URL(MOBILE_WEB_SIGN_IN_URL);
    url.searchParams.set("__clerk_ticket", signInToken.token);
    url.searchParams.set("mobile_handoff", "1");
    res.json({ bootstrapUrl: url.toString() });
  } catch (err) {
    req.log.error(
      {
        userId: mobile.userId,
        providerError:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : { name: "UnknownError" },
      },
      "Mobile web-session handoff error",
    );
    res.status(502).json({ error: "Unable to open the dashboard right now" });
  }
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const otpRequestSchema = z.object({
  email: z.string().email(),
});

const otpVerifySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const googleSchema = z
  .object({
    idToken: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
  })
  .refine((d) => d.idToken ?? d.accessToken, {
    message: "Either idToken or accessToken is required",
  });

const appleSchema = z.object({
  identityToken: z.string().min(1),
  nonce: z.string().min(32).max(256),
});

const appleLinkSchema = z.object({
  linkToken: z.string().min(1),
  email: z.string().email(),
  otp: z.string().length(6),
});

// ─── OTP in-memory store ─────────────────────────────────────────────────────

interface OtpEntry {
  otp: string;
  expiresAt: number;
  attempts: number;
}

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const otpStore = new Map<string, OtpEntry>();

function generateOtp(): string {
  return String(randomInt(100000, 1_000_000));
}

const OTP_REQUEST_RATE_LIMIT = {
  maxRequests: 5,
  windowMs: 15 * 60 * 1000,
};
const OTP_VERIFY_RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 15 * 60 * 1000,
};

async function otpRateLimited(
  req: Parameters<typeof otpRateLimitClientIp>[0],
  operation: "request" | "verify",
  email: string,
): Promise<boolean> {
  const limit = operation === "request" ? OTP_REQUEST_RATE_LIMIT : OTP_VERIFY_RATE_LIMIT;
  const allowed = await consumeOtpRateLimit(
    [
      `mobile:${operation}:ip:${otpRateLimitClientIp(req)}`,
      `mobile:${operation}:account:${email}`,
    ],
    limit,
  );
  return !allowed;
}

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

function mobileUserResponse(user: Awaited<ReturnType<typeof clerkClient.users.getUser>>, email: string) {
  return {
    id: user.id,
    email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
  };
}

async function isAuthorizedMobileUser(userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM workspace_members
      WHERE member_user_id=$1
        AND revoked_at IS NULL
        AND (access_expires_at IS NULL OR access_expires_at > now())
      LIMIT 1`,
    [userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Email/password login ─────────────────────────────────────────────────────

router.post("/mobile/auth/login", async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { email, password } = parse.data;

  try {
    const { data: users } = await clerkClient.users.getUserList({
      emailAddress: [email],
      limit: 1,
    });

    if (!users || users.length === 0) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const user = users[0];

    if (!user.passwordEnabled) {
      res.status(401).json({
        error:
          "No password set for this account — ask your workspace owner to set a mobile app password for you",
      });
      return;
    }

    let verified = false;
    try {
      const result = await clerkClient.users.verifyPassword({
        userId: user.id,
        password,
      });
      verified = result.verified;
    } catch {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (!verified) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const primaryEmail =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? email;

    const token = await signMobileToken(user.id, primaryEmail);

    res.json({
      token,
      user: {
        id: user.id,
        email: primaryEmail,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Mobile auth login error");
    res.status(500).json({ error: "Authentication service error" });
  }
});

// ─── Email OTP — request ──────────────────────────────────────────────────────

router.post("/mobile/auth/otp/request", async (req, res) => {
  const parse = otpRequestSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { email } = parse.data;
  const emailLower = email.toLowerCase();
  if (await otpRateLimited(req, "request", emailLower)) {
    res.status(429).json({ error: "Too many OTP requests — please try again later" });
    return;
  }

  // Fail fast if email service is not configured — return 503 so the client
  // can show "Email service unavailable" rather than a misleading success state.
  const resend = getResend();
  if (!resend) {
    req.log.warn({ emailLower }, "RESEND_API_KEY not set — cannot send OTP email");
    res.status(503).json({ error: "Email service unavailable — contact your administrator" });
    return;
  }

  try {
    // Verify the user exists in Clerk before issuing an OTP
    const { data: users } = await clerkClient.users.getUserList({
      emailAddress: [emailLower],
      limit: 1,
    });

    if (!users || users.length === 0) {
      // Return success to avoid email enumeration
      res.json({ sent: true });
      return;
    }

    const otp = generateOtp();
    otpStore.set(emailLower, {
      otp,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });

    const sendResult = await resend.emails.send({
      from: "Presentail OS <no-reply@presentail.com>",
      to: [emailLower],
      subject: `Your sign-in code: ${otp}`,
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px 24px">
          <p style="font-size:14px;color:#6b7280;margin:0 0 8px">Presentail OS</p>
          <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0 0 24px">Your sign-in code</h1>
          <p style="font-size:15px;color:#374151;margin:0 0 24px">
            Use the code below to sign in to Presentail OS. It expires in 10 minutes.
          </p>
          <div style="background:#f3f4f6;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
            <span style="font-size:36px;font-weight:700;letter-spacing:12px;color:#111827">${otp}</span>
          </div>
          <p style="font-size:13px;color:#9ca3af;margin:0">
            If you didn't request this code, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    if (sendResult.error) {
      // Resend returned an API-level error (e.g. unverified sender domain)
      req.log.error({ err: sendResult.error, emailLower }, "Resend email send failed");
      // Remove the OTP we stored since we couldn't deliver it
      otpStore.delete(emailLower);
      res.status(500).json({ error: "Failed to send code — please try again later" });
      return;
    }

    res.json({ sent: true });
  } catch (err) {
    req.log.error({ err }, "Mobile auth OTP request error");
    res.status(500).json({ error: "Failed to send code" });
  }
});

// ─── Email OTP — verify ───────────────────────────────────────────────────────

router.post("/mobile/auth/otp/verify", async (req, res) => {
  const parse = otpVerifySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { email, otp } = parse.data;
  const emailLower = email.toLowerCase();
  if (await otpRateLimited(req, "verify", emailLower)) {
    res.status(429).json({ error: "Too many OTP attempts — please try again later" });
    return;
  }

  const entry = otpStore.get(emailLower);

  if (!entry) {
    res.status(401).json({ error: "No code was requested for this email" });
    return;
  }

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(emailLower);
    res.status(401).json({ error: "Code expired — please request a new one" });
    return;
  }

  entry.attempts += 1;

  if (entry.attempts > MAX_ATTEMPTS) {
    otpStore.delete(emailLower);
    res.status(429).json({ error: "Too many attempts — please request a new code" });
    return;
  }

  if (entry.otp !== otp) {
    res.status(401).json({ error: "Incorrect code" });
    return;
  }

  // Code is correct — clean up and issue token
  otpStore.delete(emailLower);

  try {
    const { data: users } = await clerkClient.users.getUserList({
      emailAddress: [emailLower],
      limit: 1,
    });

    if (!users || users.length === 0) {
      res.status(401).json({ error: "Account not found" });
      return;
    }

    const user = users[0];
    const primaryEmail =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? emailLower;

    const token = await signMobileToken(user.id, primaryEmail);

    res.json({
      token,
      user: {
        id: user.id,
        email: primaryEmail,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Mobile auth OTP verify error");
    res.status(500).json({ error: "Authentication service error" });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────
//
// Accepts either:
//  - idToken  (from @react-native-google-signin/google-signin on native iOS)
//  - accessToken (from expo-auth-session on web, legacy)
//
// Clerk user lookup — three-tier strategy:
//  1. getUserList({ emailAddress }) — fastest; covers most cases
//  2. getUserList({ query }) + exact email match on emailAddresses — catches
//     edge cases where Clerk indexed the address differently
//  3. getUserList({ query: googleSub }) + match on externalAccounts
//     (provider === 'oauth_google', providerUserId === googleSub) — catches
//     users whose Clerk record is linked via Google OAuth but whose stored
//     email address diverges from the current Google account email

router.post("/mobile/auth/google", async (req, res) => {
  const parse = googleSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { idToken, accessToken } = parse.data;

  try {
    let googleEmail: string | undefined;
    let googleSub: string | undefined;
    let givenName: string | undefined;
    let familyName: string | undefined;

    if (idToken) {
      // Native iOS path — verify the ID token via Google's tokeninfo endpoint.
      // tokeninfo returns: sub (stable Google user ID), email, email_verified,
      // given_name, family_name.
      const tokenInfoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      );

      if (!tokenInfoRes.ok) {
        res.status(401).json({ error: "Invalid Google ID token" });
        return;
      }

      const tokenInfo = (await tokenInfoRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: string;
        given_name?: string;
        family_name?: string;
        error?: string;
      };

      if (tokenInfo.error) {
        res.status(401).json({ error: "Invalid Google ID token" });
        return;
      }

      if (tokenInfo.email_verified !== "true") {
        res.status(401).json({ error: "Google email address is not verified" });
        return;
      }

      googleEmail = tokenInfo.email;
      googleSub = tokenInfo.sub;
      givenName = tokenInfo.given_name;
      familyName = tokenInfo.family_name;
    } else if (accessToken) {
      // Web / legacy path — exchange access token for user info.
      // userinfo v2 returns: id (= Google sub), email, verified_email,
      // given_name, family_name.
      const googleRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      if (!googleRes.ok) {
        res.status(401).json({ error: "Invalid Google token" });
        return;
      }

      const googleUser = (await googleRes.json()) as {
        id?: string;
        email?: string;
        given_name?: string;
        family_name?: string;
        verified_email?: boolean;
      };

      googleEmail = googleUser.email;
      googleSub = googleUser.id;
      givenName = googleUser.given_name;
      familyName = googleUser.family_name;
    }

    if (!googleEmail) {
      req.log.warn({ googleSub }, "Mobile Google auth: Google returned no email");
      res.status(401).json({ error: "Google account has no email address" });
      return;
    }

    const emailLower = googleEmail.toLowerCase();

    // ── Tier 1: exact email address lookup ────────────────────────────────────
    const { data: tier1Users } = await clerkClient.users.getUserList({
      emailAddress: [emailLower],
      limit: 1,
    });
    let user = tier1Users.length > 0 ? tier1Users[0] : null;
    let lookupTier = 1;

    // ── Tier 2: broad query + exact email match on emailAddresses ─────────────
    if (!user) {
      req.log.info(
        { googleEmail: emailLower, googleSub },
        "Mobile Google auth: tier-1 email lookup missed; trying tier-2 query search",
      );
      const { data: tier2Users } = await clerkClient.users.getUserList({
        query: emailLower,
        limit: 10,
      });
      const tier2Match = tier2Users.find((u) =>
        u.emailAddresses.some(
          (e) => e.emailAddress.toLowerCase() === emailLower,
        ),
      );
      if (tier2Match) {
        user = tier2Match;
        lookupTier = 2;
      }
    }

    // ── Tier 3: Google provider user ID (sub) matched via externalAccounts ────
    // Handles the case where the user signed in via Google OAuth on the web
    // (Clerk created an external account for them) but the stored email address
    // in Clerk diverges from the current Google account email — e.g. email was
    // changed after initial sign-up, or Clerk stored only the OAuth identity.
    if (!user && googleSub) {
      req.log.info(
        { googleEmail: emailLower, googleSub },
        "Mobile Google auth: tier-2 missed; trying tier-3 Google sub / external-account lookup",
      );
      const { data: subUsers } = await clerkClient.users.getUserList({
        query: googleSub,
        limit: 5,
      });
      const tier3Match = subUsers.find((u) =>
        u.externalAccounts.some(
          (ea) =>
            ea.provider === "oauth_google" && ea.providerUserId === googleSub,
        ),
      );
      if (tier3Match) {
        user = tier3Match;
        lookupTier = 3;
      }
    }

    if (!user) {
      req.log.warn(
        { googleEmail: emailLower, googleSub },
        "Mobile Google auth: no Clerk user found — all three lookup tiers missed",
      );
      res.status(401).json({
        error:
          "No Presentail OS account found for this Google account. Contact your administrator.",
      });
      return;
    }

    const primaryEmail =
      user.emailAddresses.find((e) => e.id === user!.primaryEmailAddressId)
        ?.emailAddress ?? emailLower;

    req.log.info(
      { userId: user.id, primaryEmail, lookupTier },
      "Mobile Google auth: sign-in successful",
    );

    const token = await signMobileToken(user.id, primaryEmail);

    res.json({
      token,
      user: {
        id: user.id,
        email: primaryEmail,
        firstName: user.firstName ?? givenName ?? null,
        lastName: user.lastName ?? familyName ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Mobile auth Google error");
    res.status(500).json({ error: "Authentication service error" });
  }
});

// ─── Sign in with Apple ──────────────────────────────────────────────────────

router.post("/mobile/auth/apple", async (req, res) => {
  const parse = appleSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: "INVALID_REQUEST", error: "Invalid request body" });
    return;
  }

  let identity: Awaited<ReturnType<typeof verifyAppleIdentityToken>>;
  try {
    identity = await verifyAppleIdentityToken(parse.data.identityToken, parse.data.nonce);
  } catch (error) {
    req.log.warn({ err: error }, "Mobile Apple credential verification rejected");
    res.status(401).json({
      code: "APPLE_CREDENTIALS_INVALID",
      error: "Invalid or expired Apple sign-in. Please try again.",
    });
    return;
  }

  try {
    const nonceHash = createHash("sha256").update(parse.data.nonce).digest("hex");
    const consumed = await db.query(
      `DELETE FROM apple_auth_challenges
        WHERE nonce_hash=$1 AND expires_at > now()
        RETURNING nonce_hash`,
      [nonceHash],
    );
    if ((consumed.rowCount ?? 0) !== 1) {
      res.status(401).json({
        code: "APPLE_NONCE_EXPIRED",
        error: "Apple sign-in request expired or was already used. Please try again.",
      });
      return;
    }
    const mapped = await db.query<{ clerk_user_id: string }>(
      `SELECT clerk_user_id FROM apple_identities WHERE apple_subject=$1 LIMIT 1`,
      [identity.sub],
    );

    if (mapped.rows[0]) {
      const user = await clerkClient.users.getUser(mapped.rows[0].clerk_user_id);
      if (!(await isAuthorizedMobileUser(user.id))) {
        res.status(401).json({
          code: "APPLE_ACCOUNT_NOT_AUTHORIZED",
          error: "Unable to sign in with Apple for this account",
        });
        return;
      }
      const email =
        user.emailAddresses.find((item) => item.id === user.primaryEmailAddressId)?.emailAddress ??
        user.emailAddresses[0]?.emailAddress;
      if (!email) {
        res.status(401).json({
          code: "APPLE_ACCOUNT_NOT_AUTHORIZED",
          error: "Unable to sign in with Apple for this account",
        });
        return;
      }
      await db.query(
        `UPDATE apple_identities SET last_signed_in_at=now() WHERE apple_subject=$1`,
        [identity.sub],
      );
      res.json({ token: await signMobileToken(user.id, email), user: mobileUserResponse(user, email) });
      return;
    }

    if (identity.email && identity.emailVerified && !identity.isPrivateEmail) {
      const { data: users } = await clerkClient.users.getUserList({
        emailAddress: [identity.email],
        limit: 1,
      });
      const user = users[0];
      if (user && (await isAuthorizedMobileUser(user.id))) {
        try {
          await db.query(
            `INSERT INTO apple_identities (apple_subject, clerk_user_id, linked_email)
             VALUES ($1,$2,$3)`,
            [identity.sub, user.id, identity.email],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            res.status(409).json({
              code: "APPLE_IDENTITY_CONFLICT",
              error: "This Apple ID is already linked to another account",
            });
            return;
          }
          throw error;
        }
        res.json({
          token: await signMobileToken(user.id, identity.email),
          user: mobileUserResponse(user, identity.email),
        });
        return;
      }
    }

    // The same response is used for private relay and every unrecognized email.
    // It reveals no account-existence result; ownership is proven by email OTP.
    res.status(202).json({
      code: "APPLE_EMAIL_LINK_REQUIRED",
      requiresLink: true,
      linkToken: createAppleLinkToken(identity.sub),
      message: "Verify your invited Presentail email to continue",
    });
  } catch (error) {
    req.log.error({ err: error }, "Mobile Apple authentication service error");
    res.status(503).json({
      code: "AUTH_SERVICE_UNAVAILABLE",
      error: "Apple sign in is temporarily unavailable. Please try again.",
    });
  }
});

router.post("/mobile/auth/apple/challenge", async (_req, res) => {
  const nonce = randomBytes(32).toString("base64url");
  const nonceHash = createHash("sha256").update(nonce).digest("hex");
  await db.query(`DELETE FROM apple_auth_challenges WHERE expires_at <= now()`);
  await db.query(
    `INSERT INTO apple_auth_challenges (nonce_hash, expires_at)
     VALUES ($1, now() + interval '10 minutes')`,
    [nonceHash],
  );
  res.json({ nonce });
});

router.post("/mobile/auth/apple/link", async (req, res) => {
  const parse = appleLinkSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: "INVALID_REQUEST", error: "Invalid request body" });
    return;
  }
  const { linkToken, otp } = parse.data;
  const email = parse.data.email.toLowerCase();
  const subject = verifyAppleLinkToken(linkToken);
  if (!subject) {
    res.status(401).json({
      code: "APPLE_LINK_EXPIRED",
      error: "Apple linking request expired. Please start again.",
    });
    return;
  }
  if (await otpRateLimited(req, "verify", email)) {
    res.status(429).json({
      code: "APPLE_OTP_RATE_LIMITED",
      error: "Too many OTP attempts — please try again later",
    });
    return;
  }
  const entry = otpStore.get(email);
  if (!entry || Date.now() > entry.expiresAt || entry.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(email);
    res.status(401).json({
      code: "APPLE_OTP_INVALID",
      error: "The verification code is invalid or expired",
    });
    return;
  }
  entry.attempts += 1;
  if (entry.otp !== otp) {
    res.status(401).json({
      code: "APPLE_OTP_INVALID",
      error: "The verification code is invalid or expired",
    });
    return;
  }

  try {
    const { data: users } = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
    const user = users[0];
    if (!user || !(await isAuthorizedMobileUser(user.id))) {
      res.status(401).json({
        code: "APPLE_ACCOUNT_NOT_AUTHORIZED",
        error: "Unable to link Apple sign-in to this account",
      });
      return;
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO apple_identities (apple_subject, clerk_user_id, linked_email)
         VALUES ($1,$2,$3)`,
        [subject, user.id, email],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({
          code: "APPLE_IDENTITY_CONFLICT",
          error: "This Apple ID or account is already linked",
        });
        return;
      }
      throw error;
    } finally {
      client.release();
    }
    otpStore.delete(email);
    res.json({ token: await signMobileToken(user.id, email), user: mobileUserResponse(user, email) });
  } catch (error) {
    req.log.error({ err: error }, "Mobile Apple account linking failed");
    res.status(503).json({
      code: "AUTH_SERVICE_UNAVAILABLE",
      error: "Apple linking is temporarily unavailable. Please try again.",
    });
  }
});

export default router;
