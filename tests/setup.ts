/**
 * Test bootstrap. Points the suite at a dedicated database and forces the
 * offline embedding provider so no test needs network access or an API key.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://contextbridge:contextbridge@localhost:5432/contextbridge_test";
process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough-000000";
process.env.CREDENTIAL_SECRET = "test-credential-secret-that-is-long-enough-00";
process.env.EMBEDDING_PROVIDER = "local";
process.env.LOG_LEVEL = "error";
delete process.env.ANTHROPIC_API_KEY;
