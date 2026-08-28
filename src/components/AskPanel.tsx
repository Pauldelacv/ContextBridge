"use client";

import { useState } from "react";
import type { FormEvent } from "react";

interface Citation {
  sourceNumber: number;
  title: string;
  url: string | null;
  provider: string;
  excerpt: string;
}

interface Source {
  chunkId: string;
  title: string;
  url: string | null;
  provider: string;
  excerpt: string;
  score: number;
}

interface AskResponse {
  question: string;
  answer: string;
  citations: Citation[];
  sources: Source[];
  abstained: boolean;
  latencyMs: number;
}

const PROVIDER_LABEL: Record<string, string> = {
  notion: "Notion",
  google_drive: "Google Drive",
  slack: "Slack",
};

/**
 * The question surface. It is a client component because it owns transient
 * request state and nothing else — the retrieval, ranking and generation all
 * happen server-side behind /api/ask.
 */
export function AskPanel({ suggestions }: { suggestions: string[] }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length < 3) {
      setError("Ask a slightly longer question.");
      return;
    }

    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });

      const body = (await response.json()) as AskResponse | { error?: { message?: string } };

      if (!response.ok) {
        const message =
          "error" in body && body.error?.message
            ? body.error.message
            : "Something went wrong answering that.";
        setError(message);
        return;
      }

      setResult(body as AskResponse);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit(question);
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={onSubmit}>
        <div className="field">
          <label className="label" htmlFor="question">
            Ask across every connected source
          </label>
          <textarea
            className="textarea"
            id="question"
            name="question"
            value={question}
            placeholder="How much can I expense for a client dinner?"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              // Cmd/Ctrl+Enter submits — the textarea keeps plain Enter for newlines.
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit(question);
              }
            }}
          />
        </div>

        <div className="row-between spread">
          <span className="subtle">Answers are grounded in your documents and always cite them.</span>
          <button className="button" type="submit" disabled={pending}>
            {pending ? <span className="spinner" aria-hidden="true" /> : null}
            {pending ? "Searching..." : "Ask"}
          </button>
        </div>
      </form>

      {!result && !pending && suggestions.length > 0 ? (
        <div className="card stack">
          <h3>Try one of these</h3>
          <div className="row spread" style={{ flexWrap: "wrap" }}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="button button-secondary button-small"
                onClick={() => {
                  setQuestion(suggestion);
                  void submit(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="card stack">
            <div className="row-between spread">
              <h2>Answer</h2>
              <span className="badge">{result.latencyMs} ms</span>
            </div>
            <p className="answer">{result.answer}</p>
            {result.abstained ? (
              <div className="alert">
                No source directly answered this. It may not be documented yet, or the
                system holding it may not be connected.
              </div>
            ) : null}
          </div>

          {result.citations.length > 0 ? (
            <div className="card stack">
              <h3>Cited sources</h3>
              <ul className="citation-list">
                {result.citations.map((citation) => (
                  <li className="citation" key={`${citation.sourceNumber}-${citation.title}`}>
                    <span className="citation-number">{citation.sourceNumber}</span>
                    <div style={{ minWidth: 0 }}>
                      <div>
                        {citation.url ? (
                          <a href={citation.url} target="_blank" rel="noreferrer">
                            {citation.title}
                          </a>
                        ) : (
                          citation.title
                        )}{" "}
                        <span className="badge">
                          {PROVIDER_LABEL[citation.provider] ?? citation.provider}
                        </span>
                      </div>
                      <p className="citation-excerpt">{citation.excerpt}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.sources.length > 0 ? (
            <details className="card">
              <summary style={{ cursor: "pointer", fontWeight: 550 }}>
                Everything retrieved ({result.sources.length})
              </summary>
              <ul className="citation-list" style={{ marginTop: 12 }}>
                {result.sources.map((source) => (
                  <li className="citation" key={source.chunkId}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row spread">
                        <strong>{source.title}</strong>
                        <span className="badge">
                          {PROVIDER_LABEL[source.provider] ?? source.provider}
                        </span>
                        <span className="subtle mono">{source.score.toFixed(3)}</span>
                      </div>
                      <p className="citation-excerpt">{source.excerpt}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
