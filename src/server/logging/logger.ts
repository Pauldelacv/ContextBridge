import { getEnv } from "@/server/config/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

/**
 * Structured JSON logging. One line per event so a log shipper can index it,
 * with a bound context (orgId, jobId, requestId) carried through a request or
 * job without every call site re-passing it.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(context: LogFields): Logger;
}

function serialiseError(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: serialiseError(value.cause) }),
    };
  }
  return value;
}

function normalise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serialiseError(value) : value;
  }
  return out;
}

function create(context: LogFields): Logger {
  const threshold = LEVEL_WEIGHT[getEnv().LOG_LEVEL];

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message,
      ...normalise(context),
      ...(fields ? normalise(fields) : {}),
    });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => create({ ...context, ...extra }),
  };
}

export const logger: Logger = create({});

export function createLogger(context: LogFields): Logger {
  return create(context);
}
