import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { SourceCard } from "@/components/SourceCard";
import { getAuthContext } from "@/server/auth/current";
import { listIntegrationSummaries } from "@/server/integrations/service";

export const dynamic = "force-dynamic";

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const params = await searchParams;
  const connected = typeof params.connected === "string" ? params.connected : null;
  const failed = typeof params.error === "string" ? params.error : null;

  const summaries = await listIntegrationSummaries(auth.organizationId);
  const anyConfigured = summaries.some((summary) => summary.configured);

  return (
    <AppShell current="/sources" organizationName={auth.organizationName} userName={auth.userName}>
      <div className="page-header">
        <h1>Sources</h1>
        <p>
          Connect the systems where your knowledge already lives. Each one syncs on its
          own schedule and keeps its documents up to date.
        </p>
      </div>

      <div className="stack">
        {connected ? (
          <div className="alert alert-ok">
            Connected {connected.replace("_", " ")}. The first sync is running in the
            background — documents will appear as it works through them.
          </div>
        ) : null}

        {failed ? <div className="alert alert-error">Authorization failed: {failed}</div> : null}

        {!anyConfigured ? (
          <div className="alert">
            No connector has credentials configured on this deployment. Set the client id
            and secret for at least one provider in your environment, then restart.
          </div>
        ) : null}

        {summaries.map((summary) => (
          <SourceCard
            key={summary.provider}
            provider={summary.provider}
            displayName={summary.displayName}
            description={summary.description}
            configured={summary.configured}
            supportsIncrementalSync={summary.supportsIncrementalSync}
            connection={
              summary.connection
                ? {
                    ...summary.connection,
                    lastSyncedAt: summary.connection.lastSyncedAt?.toISOString() ?? null,
                  }
                : null
            }
          />
        ))}
      </div>
    </AppShell>
  );
}
