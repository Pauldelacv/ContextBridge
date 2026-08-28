import { redirect } from "next/navigation";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { AppShell } from "@/components/AppShell";
import { getAuthContext } from "@/server/auth/current";
import { getDb } from "@/server/db/client";
import { chunks, documents, queryLogs, syncJobs } from "@/server/db/schema";

export const dynamic = "force-dynamic";

const STATUS_CLASS: Record<string, string> = {
  succeeded: "badge-ok",
  pending: "badge",
  running: "badge-warn",
  failed: "badge-warn",
  dead: "badge-error",
};

function relativeTime(value: Date | null): string {
  if (!value) return "never";
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export default async function DashboardPage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const db = getDb();
  const organizationId = auth.organizationId;

  // Every query below is scoped to the session's organization.
  const [documentCount] = await db
    .select({ total: count() })
    .from(documents)
    .where(and(eq(documents.organizationId, organizationId), isNull(documents.deletedAt)));

  const [chunkCount] = await db
    .select({ total: count() })
    .from(chunks)
    .where(eq(chunks.organizationId, organizationId));

  const [questionCount] = await db
    .select({ total: count() })
    .from(queryLogs)
    .where(eq(queryLogs.organizationId, organizationId));

  const [latency] = await db
    .select({
      p50: sql<number | null>`percentile_disc(0.5) WITHIN GROUP (ORDER BY ${queryLogs.latencyMs})`,
    })
    .from(queryLogs)
    .where(and(eq(queryLogs.organizationId, organizationId), sql`${queryLogs.latencyMs} IS NOT NULL`));

  const byProvider = await db
    .select({ provider: documents.provider, total: count() })
    .from(documents)
    .where(and(eq(documents.organizationId, organizationId), isNull(documents.deletedAt)))
    .groupBy(documents.provider);

  const recentJobs = await db
    .select({
      id: syncJobs.id,
      type: syncJobs.type,
      status: syncJobs.status,
      attempts: syncJobs.attempts,
      lastError: syncJobs.lastError,
      updatedAt: syncJobs.updatedAt,
    })
    .from(syncJobs)
    .where(eq(syncJobs.organizationId, organizationId))
    .orderBy(desc(syncJobs.updatedAt))
    .limit(8);

  const recentQuestions = await db
    .select({
      id: queryLogs.id,
      question: queryLogs.question,
      latencyMs: queryLogs.latencyMs,
      surface: queryLogs.surface,
      error: queryLogs.error,
      createdAt: queryLogs.createdAt,
    })
    .from(queryLogs)
    .where(eq(queryLogs.organizationId, organizationId))
    .orderBy(desc(queryLogs.createdAt))
    .limit(8);

  return (
    <AppShell current="/dashboard" organizationName={auth.organizationName} userName={auth.userName}>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>What is indexed, what is syncing, and what people are asking.</p>
      </div>

      <div className="grid grid-stats">
        <div className="card">
          <div className="stat-value">{documentCount?.total ?? 0}</div>
          <div className="stat-label">Documents indexed</div>
        </div>
        <div className="card">
          <div className="stat-value">{chunkCount?.total ?? 0}</div>
          <div className="stat-label">Searchable chunks</div>
        </div>
        <div className="card">
          <div className="stat-value">{questionCount?.total ?? 0}</div>
          <div className="stat-label">Questions asked</div>
        </div>
        <div className="card">
          <div className="stat-value">
            {latency?.p50 != null ? `${Math.round(Number(latency.p50))} ms` : "—"}
          </div>
          <div className="stat-label">Median answer time</div>
        </div>
      </div>

      <div style={{ marginTop: 24 }} className="stack">
        <div className="card stack">
          <h2>Sources</h2>
          {byProvider.length === 0 ? (
            <p className="muted">Nothing indexed yet.</p>
          ) : (
            <div className="row spread" style={{ flexWrap: "wrap" }}>
              {byProvider.map((row) => (
                <span className="badge" key={row.provider}>
                  {row.provider.replace("_", " ")}: {row.total}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="card stack">
          <h2>Recent sync jobs</h2>
          {recentJobs.length === 0 ? (
            <p className="muted">No sync jobs yet. Connect a source to start ingesting.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <span className="mono">{job.type}</span>
                        {job.lastError ? (
                          <div className="subtle truncate" title={job.lastError}>
                            {job.lastError}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_CLASS[job.status] ?? ""}`}>{job.status}</span>
                      </td>
                      <td>{job.attempts}</td>
                      <td className="muted">{relativeTime(job.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card stack">
          <h2>Recent questions</h2>
          {recentQuestions.length === 0 ? (
            <p className="muted">No questions asked yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Where</th>
                    <th>Latency</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentQuestions.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <span className="truncate" title={entry.question}>
                          {entry.question}
                        </span>
                        {entry.error ? (
                          <span className="badge badge-error" style={{ marginTop: 4 }}>
                            failed
                          </span>
                        ) : null}
                      </td>
                      <td className="muted">{entry.surface}</td>
                      <td className="muted">{entry.latencyMs ? `${entry.latencyMs} ms` : "—"}</td>
                      <td className="muted">{relativeTime(entry.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
