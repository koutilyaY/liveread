import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  /** comma-separated allowlist of browser origins */
  WEB_ORIGINS: z.string().default("http://localhost:3000"),
  COOKIE_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("liveread-recordings"),
  S3_ACCESS_KEY: z.string().default("liveread"),
  S3_SECRET_KEY: z.string().default("liveread-secret"),
  SMTP_URL: z.string().default("smtp://localhost:1025"),
  MAIL_FROM: z.string().default("LiveRead <no-reply@liveread.local>"),
  APP_NAME: z.string().default("LiveRead"),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  STT_PROVIDER: z.enum(["fake", "deepgram"]).default("fake"),
  STT_FALLBACK_PROVIDER: z.enum(["fake", "deepgram", "none"]).default("fake"),
  DEEPGRAM_API_KEY: z.string().optional(),
  /** hard cost-control limits */
  MAX_SESSION_MINUTES: z.coerce.number().int().default(180),
  MAX_VIEWERS_PER_SESSION: z.coerce.number().int().default(2000),
  MAX_CONCURRENT_SESSIONS_PER_USER: z.coerce.number().int().default(3),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  /**
   * Who may set X-Forwarded-For. "false" (default) = the API is directly
   * exposed and the socket address is authoritative. Set to a comma-separated
   * list of trusted proxy IPs/CIDRs (or "true" ONLY when nothing untrusted can
   * reach the API) when running behind a load balancer. Trusting XFF from
   * anyone lets a client forge its IP and mint a fresh rate-limit bucket per
   * request, defeating throttling and share-link enumeration protection.
   */
  TRUST_PROXY: z.string().default("false"),
  /**
   * How often a connected viewer socket re-checks that its access is still
   * valid (revoked / expired / session deleted). Lower = tighter revocation
   * latency at the cost of one small query per viewer per interval.
   */
  VIEWER_REAUTH_INTERVAL_MS: z.coerce.number().int().min(200).default(15_000),
  /** dev/test only: skip real email delivery */
  EMAIL_AUTOVERIFY: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(overrides?: Partial<Record<string, string>>): Env {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return parsed.data;
}

export function env(): Env {
  return cached ?? loadEnv();
}

/**
 * Fastify `trustProxy` value. Never returns bare `true` unless explicitly
 * configured, so a default deployment cannot have its IP-based rate limits
 * bypassed with a forged X-Forwarded-For header.
 */
export function trustProxyConfig(): boolean | string[] {
  const raw = env().TRUST_PROXY.trim();
  if (raw === "" || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function webOrigins(): string[] {
  return env()
    .WEB_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
