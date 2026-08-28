import { z } from "zod";

/**
 * The single place where `process.env` is read. Everything downstream receives
 * a typed, validated object — no `process.env.FOO!` scattered across modules.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  CREDENTIAL_SECRET: z.string().min(32, "CREDENTIAL_SECRET must be at least 32 characters"),

  EMBEDDING_PROVIDER: z.enum(["local", "voyage", "openai"]).default("local"),
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),

  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Dev/test convenience: secrets are required in production but we do not want
 * `npm test` or a first `npm run dev` to fail on boilerplate the developer has
 * not filled in yet. Production gets no such fallback.
 */
function withDevDefaults(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (raw.NODE_ENV === "production") return raw;
  return {
    ...raw,
    DATABASE_URL:
      raw.DATABASE_URL ?? "postgres://contextbridge:contextbridge@localhost:5432/contextbridge",
    SESSION_SECRET: raw.SESSION_SECRET ?? "dev-session-secret-not-for-production-use!!",
    CREDENTIAL_SECRET: raw.CREDENTIAL_SECRET ?? "dev-credential-secret-not-for-production!!",
  };
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(withDevDefaults(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: forget the memoised env so a test can swap `process.env`. */
export function resetEnvCache(): void {
  cached = null;
}
