import { redirect } from "next/navigation";
import { and, count, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/AppShell";
import { AskPanel } from "@/components/AskPanel";
import { getAuthContext } from "@/server/auth/current";
import { getDb } from "@/server/db/client";
import { documents } from "@/server/db/schema";

export const dynamic = "force-dynamic";

const SUGGESTIONS = [
  "What is our expense policy for travel?",
  "How do I request time off?",
  "What is the deployment process?",
  "Who owns the billing service?",
];

export default async function AskPage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const [indexed] = await getDb()
    .select({ total: count() })
    .from(documents)
    .where(and(eq(documents.organizationId, auth.organizationId), isNull(documents.deletedAt)));

  const hasContent = (indexed?.total ?? 0) > 0;

  return (
    <AppShell current="/ask" organizationName={auth.organizationName} userName={auth.userName}>
      <div className="page-header">
        <h1>Ask</h1>
        <p>
          One question, every connected system. Answers cite the documents they came from.
        </p>
      </div>

      {hasContent ? (
        <AskPanel suggestions={SUGGESTIONS} />
      ) : (
        <div className="empty">
          <p style={{ fontWeight: 550, color: "var(--text)" }}>Nothing indexed yet</p>
          <p style={{ marginTop: 6 }}>
            Connect a source to give ContextBridge something to search.
          </p>
          <p style={{ marginTop: 14 }}>
            <a className="button" href="/sources">
              Connect a source
            </a>
          </p>
        </div>
      )}
    </AppShell>
  );
}
