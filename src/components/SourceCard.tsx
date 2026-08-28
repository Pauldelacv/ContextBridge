"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface SourceCardProps {
  provider: string;
  displayName: string;
  description: string;
  configured: boolean;
  supportsIncrementalSync: boolean;
  connection: {
    id: string;
    displayName: string;
    status: string;
    lastSyncedAt: string | null;
    lastError: string | null;
    documentCount: number;
  } | null;
}

const STATUS_CLASS: Record<string, string> = {
  connected: "badge-ok",
  syncing: "badge-warn",
  error: "badge-error",
  disconnected: "badge",
};

export function SourceCard(props: SourceCardProps) {
  const { connection } = props;
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function callApi(url: string, body?: unknown, action?: string): Promise<void> {
    setPending(action ?? url);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const payload = (await response.json().catch(() => null)) as
        | { authorizationUrl?: string; error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not work. Please try again.");
        return;
      }
      if (payload?.authorizationUrl) {
        window.location.href = payload.authorizationUrl;
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="card stack">
      <div className="row-between spread">
        <div>
          <div className="row">
            <h3>{props.displayName}</h3>
            {connection ? (
              <span className={`badge ${STATUS_CLASS[connection.status] ?? ""}`}>
                {connection.status}
              </span>
            ) : null}
            {/* Only meaningful when there is nothing connected: it explains why
                the Connect button is disabled. */}
            {!props.configured && !connection ? (
              <span className="badge">not configured</span>
            ) : null}
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            {props.description}
          </p>
        </div>

        <div className="row">
          {connection ? (
            <>
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={pending !== null}
                onClick={() =>
                  void callApi(
                    `/api/integrations/${connection.id}/sync`,
                    { mode: props.supportsIncrementalSync ? "incremental" : "full" },
                    "sync",
                  )
                }
              >
                {pending === "sync" ? "Queueing..." : "Sync now"}
              </button>
              <button
                type="button"
                className="button button-danger button-small"
                disabled={pending !== null}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Disconnect ${props.displayName}? Its ${connection.documentCount} indexed documents will be removed and will stop being searchable.`,
                    )
                  ) {
                    return;
                  }
                  void callApi(`/api/integrations/${connection.id}/disconnect`, {}, "disconnect");
                }}
              >
                {pending === "disconnect" ? "Removing..." : "Disconnect"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button button-small"
              disabled={!props.configured || pending !== null}
              title={
                props.configured
                  ? undefined
                  : `Set the ${props.displayName} client id and secret to enable this connector.`
              }
              onClick={() => void callApi("/api/integrations/connect", { provider: props.provider }, "connect")}
            >
              {pending === "connect" ? "Redirecting..." : "Connect"}
            </button>
          )}
        </div>
      </div>

      {connection ? (
        <div className="row spread" style={{ flexWrap: "wrap" }}>
          <span className="subtle">{connection.displayName}</span>
          <span className="subtle">{connection.documentCount} documents</span>
          <span className="subtle">
            Last synced:{" "}
            {connection.lastSyncedAt
              ? new Date(connection.lastSyncedAt).toLocaleString()
              : "not yet"}
          </span>
        </div>
      ) : null}

      {connection?.lastError ? (
        <div className="alert alert-error">Last sync failed: {connection.lastError}</div>
      ) : null}

      {error ? <div className="alert alert-error">{error}</div> : null}
    </div>
  );
}
