/**
 * A tiny in-process metrics registry exposed at /api/metrics in Prometheus
 * text format. Enough to answer "is ingestion moving, are answers slow, what is
 * failing" without pulling in a metrics backend for a single-node deployment.
 */
type Labels = Record<string, string | number>;

interface CounterEntry {
  name: string;
  help: string;
  labels: Labels;
  value: number;
}

interface HistogramEntry {
  name: string;
  help: string;
  labels: Labels;
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

const BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

const counters = new Map<string, CounterEntry>();
const histograms = new Map<string, HistogramEntry>();

function keyOf(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label]}`);
  return `${name}{${parts.join(",")}}`;
}

export function incrementCounter(name: string, labels: Labels = {}, help = "", by = 1): void {
  const key = keyOf(name, labels);
  const existing = counters.get(key);
  if (existing) existing.value += by;
  else counters.set(key, { name, help, labels, value: by });
}

export function observeDuration(name: string, durationMs: number, labels: Labels = {}, help = ""): void {
  const key = keyOf(name, labels);
  let entry = histograms.get(key);
  if (!entry) {
    entry = { name, help, labels, count: 0, sum: 0, buckets: new Map(BUCKETS_MS.map((b) => [b, 0])) };
    histograms.set(key, entry);
  }
  entry.count += 1;
  entry.sum += durationMs;
  for (const bucket of BUCKETS_MS) {
    if (durationMs <= bucket) entry.buckets.set(bucket, (entry.buckets.get(bucket) ?? 0) + 1);
  }
}

export function recordRequest(route: string, status: number, durationMs: number): void {
  incrementCounter("contextbridge_http_requests_total", { route, status }, "HTTP requests handled");
  observeDuration("contextbridge_http_request_duration_ms", durationMs, { route }, "HTTP request duration");
}

export function recordJob(type: string, outcome: "succeeded" | "failed" | "dead", durationMs: number): void {
  incrementCounter("contextbridge_jobs_total", { type, outcome }, "Sync jobs processed");
  observeDuration("contextbridge_job_duration_ms", durationMs, { type }, "Sync job duration");
}

export function recordIngestion(provider: string, event: "created" | "updated" | "unchanged" | "deleted"): void {
  incrementCounter("contextbridge_documents_total", { provider, event }, "Documents seen by ingestion");
}

export function recordEmbedding(provider: string, tokens: number, durationMs: number): void {
  incrementCounter("contextbridge_embedding_tokens_total", { provider }, "Tokens sent for embedding", tokens);
  observeDuration("contextbridge_embedding_duration_ms", durationMs, { provider }, "Embedding batch duration");
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...extra };
  const parts = Object.entries(merged).map(([key, value]) => `${key}="${String(value)}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

/** Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  const documented = new Set<string>();

  for (const entry of counters.values()) {
    if (!documented.has(entry.name)) {
      documented.add(entry.name);
      if (entry.help) lines.push(`# HELP ${entry.name} ${entry.help}`);
      lines.push(`# TYPE ${entry.name} counter`);
    }
    lines.push(`${entry.name}${renderLabels(entry.labels)} ${entry.value}`);
  }

  for (const entry of histograms.values()) {
    if (!documented.has(entry.name)) {
      documented.add(entry.name);
      if (entry.help) lines.push(`# HELP ${entry.name} ${entry.help}`);
      lines.push(`# TYPE ${entry.name} histogram`);
    }
    for (const [bucket, count] of entry.buckets) {
      lines.push(`${entry.name}_bucket${renderLabels(entry.labels, { le: bucket })} ${count}`);
    }
    lines.push(`${entry.name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}`);
    lines.push(`${entry.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
    lines.push(`${entry.name}_count${renderLabels(entry.labels)} ${entry.count}`);
  }

  return `${lines.join("\n")}\n`;
}

/** Test-only. */
export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}
