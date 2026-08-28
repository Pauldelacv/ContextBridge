import { redirect } from "next/navigation";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { AppShell } from "@/components/AppShell";
import { getAuthContext } from "@/server/auth/current";
import { getDb } from "@/server/db/client";
import { chunks, documents } from "@/server/db/schema";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const PROVIDER_LABEL: Record<string, string> = {
  notion: "Notion",
  google_drive: "Google Drive",
  slack: "Slack",
};

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const params = await searchParams;
  const page = Math.max(1, Number(typeof params.page === "string" ? params.page : "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getDb();
  const scope = and(eq(documents.organizationId, auth.organizationId), isNull(documents.deletedAt));

  const [total] = await db.select({ total: count() }).from(documents).where(scope);

  // Chunk counts come from a correlated subquery rather than a second round trip.
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      url: documents.url,
      provider: documents.provider,
      sourceUpdatedAt: documents.sourceUpdatedAt,
      indexedAt: documents.indexedAt,
      chunkCount: sql<number>`(SELECT count(*) FROM ${chunks} WHERE ${chunks.documentId} = ${documents.id})`,
    })
    .from(documents)
    .where(scope)
    .orderBy(desc(documents.indexedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const totalCount = total?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <AppShell current="/documents" organizationName={auth.organizationName} userName={auth.userName}>
      <div className="page-header">
        <h1>Documents</h1>
        <p>
          Everything ContextBridge has indexed for {auth.organizationName}, and what it was
          split into for retrieval.
        </p>
      </div>

      {totalCount === 0 ? (
        <div className="empty">
          <p style={{ fontWeight: 550, color: "var(--text)" }}>No documents indexed</p>
          <p style={{ marginTop: 6 }}>Connect a source and the first sync will fill this in.</p>
          <p style={{ marginTop: 14 }}>
            <a className="button" href="/sources">
              Connect a source
            </a>
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Source</th>
                  <th>Chunks</th>
                  <th>Updated at source</th>
                  <th>Indexed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.url ? (
                        <a href={row.url} target="_blank" rel="noreferrer" className="truncate">
                          {row.title}
                        </a>
                      ) : (
                        <span className="truncate">{row.title}</span>
                      )}
                    </td>
                    <td>
                      <span className="badge">
                        {PROVIDER_LABEL[row.provider] ?? row.provider}
                      </span>
                    </td>
                    <td>{Number(row.chunkCount)}</td>
                    <td className="muted">
                      {row.sourceUpdatedAt ? row.sourceUpdatedAt.toLocaleDateString() : "—"}
                    </td>
                    <td className="muted">
                      {row.indexedAt ? row.indexedAt.toLocaleDateString() : "pending"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row-between" style={{ marginTop: 14 }}>
            <span className="subtle">
              {totalCount} document{totalCount === 1 ? "" : "s"} · page {page} of {lastPage}
            </span>
            <div className="row">
              {page > 1 ? (
                <a className="button button-secondary button-small" href={`/documents?page=${page - 1}`}>
                  Previous
                </a>
              ) : null}
              {page < lastPage ? (
                <a className="button button-secondary button-small" href={`/documents?page=${page + 1}`}>
                  Next
                </a>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
