import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import {
  hashPassword,
  ipHash,
  randomToken,
  sha256,
  verifyPassword,
} from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { env } from "../env.js";
import { SESSION_COOKIE, requireUser } from "../plugins/auth.js";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../lib/mailer.js";

const SignupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
});

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_WINDOW_S = 900;

/** strict in production; relaxed for dev/test suites */
const authLimit = (max: number) =>
  env().NODE_ENV === "production" ? max : max * 100;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

async function issueSession(
  userId: string,
  req: { headers: Record<string, unknown>; ip: string },
): Promise<string> {
  const token = randomToken(32);
  await prisma().authSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
      ipHash: ipHash(req.ip, env().COOKIE_SECRET),
    },
  });
  return token;
}

function cookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post(
    "/v1/auth/signup",
    { config: { rateLimit: { max: authLimit(10), timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const body = SignupSchema.parse(req.body);
      const db = prisma();
      const existing = await db.user.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      if (existing) {
        // uniform response prevents account enumeration timing differences
        throw Errors.conflict("An account with this email already exists.");
      }
      const passwordHash = await hashPassword(body.password);
      const verifyToken = randomToken(32);
      const user = await db.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email: body.email.toLowerCase(),
            passwordHash,
            displayName: body.displayName,
            emailVerifiedAt: env().EMAIL_AUTOVERIFY ? new Date() : null,
          },
        });
        const org = await tx.organization.create({
          data: {
            name: `${body.displayName}'s workspace`,
            slug: `${slugify(body.displayName)}-${randomToken(4).toLowerCase()}`,
          },
        });
        await tx.organizationMembership.create({
          data: { organizationId: org.id, userId: u.id, role: "owner" },
        });
        await tx.authToken.create({
          data: {
            userId: u.id,
            purpose: "email_verify",
            tokenHash: sha256(verifyToken),
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org.id,
            actorUserId: u.id,
            action: "user.signup",
            entityType: "user",
            entityId: u.id,
            requestId: req.id,
          },
        });
        return u;
      });
      if (!env().EMAIL_AUTOVERIFY) {
        await sendVerificationEmail(user.email, verifyToken).catch((err) =>
          req.log.warn({ err }, "verification_email_failed"),
        );
      }
      const token = await issueSession(user.id, req);
      reply.setCookie(SESSION_COOKIE, token, cookieOptions());
      return reply.code(201).send({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerifiedAt !== null,
      });
    },
  );

  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: authLimit(20), timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const body = LoginSchema.parse(req.body);
      const email = body.email.toLowerCase();
      const lockKey = `lockout:${sha256(email)}`;
      const failures = Number((await redis().get(lockKey)) ?? "0");
      if (failures >= LOCKOUT_THRESHOLD) {
        throw Errors.locked(
          "Too many failed sign-in attempts. Try again in 15 minutes.",
        );
      }
      const user = await prisma().user.findFirst({
        where: { email, deletedAt: null },
      });
      const ok = user
        ? await verifyPassword(user.passwordHash, body.password)
        : await verifyPassword(
            // constant-time-ish: verify against a throwaway hash
            "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            body.password,
          );
      if (!user || !ok) {
        await redis().incr(lockKey);
        await redis().expire(lockKey, LOCKOUT_WINDOW_S);
        throw Errors.invalid("Incorrect email or password.");
      }
      await redis().del(lockKey);
      const token = await issueSession(user.id, req);
      reply.setCookie(SESSION_COOKIE, token, cookieOptions());
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerifiedAt !== null,
      };
    },
  );

  app.post("/v1/auth/logout", async (req, reply) => {
    if (req.sessionTokenHash) {
      await prisma().authSession.updateMany({
        where: { tokenHash: req.sessionTokenHash },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/auth/me", async (req) => {
    const userId = requireUser(req);
    const user = await prisma().user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        locale: true,
        timezone: true,
        emailVerifiedAt: true,
        memberships: {
          select: {
            role: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      timezone: user.timezone,
      emailVerified: user.emailVerifiedAt !== null,
      organizations: user.memberships.map((m) => ({
        ...m.organization,
        role: m.role,
      })),
    };
  });

  app.post("/v1/auth/verify-email", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const db = prisma();
    const row = await db.authToken.findFirst({
      where: {
        tokenHash: sha256(token),
        purpose: "email_verify",
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!row)
      throw Errors.invalid("This verification link is invalid or expired.");
    await db.$transaction([
      db.authToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      db.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);
    return { ok: true };
  });

  app.post(
    "/v1/auth/request-password-reset",
    { config: { rateLimit: { max: authLimit(5), timeWindow: "15 minutes" } } },
    async (req) => {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      const user = await prisma().user.findFirst({
        where: { email: email.toLowerCase(), deletedAt: null },
      });
      // uniform response regardless of account existence
      if (user) {
        const token = randomToken(32);
        await prisma().authToken.create({
          data: {
            userId: user.id,
            purpose: "password_reset",
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + 1000 * 60 * 30),
          },
        });
        await sendPasswordResetEmail(user.email, token).catch((err) =>
          req.log.warn({ err }, "reset_email_failed"),
        );
      }
      return { ok: true };
    },
  );

  app.post("/v1/auth/reset-password", async (req) => {
    const { token, password } = z
      .object({
        token: z.string().min(10),
        password: z.string().min(10).max(200),
      })
      .parse(req.body);
    const db = prisma();
    const row = await db.authToken.findFirst({
      where: {
        tokenHash: sha256(token),
        purpose: "password_reset",
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!row) throw Errors.invalid("This reset link is invalid or expired.");
    const passwordHash = await hashPassword(password);
    await db.$transaction([
      db.authToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      db.user.update({ where: { id: row.userId }, data: { passwordHash } }),
      // revoke every existing session on password reset
      db.authSession.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { ok: true };
  });
}
