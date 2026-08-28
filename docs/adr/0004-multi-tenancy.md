# ADR 004 — Organization-level isolation in a shared schema

**Status:** Accepted
**Date:** 2026-08-28

## Context

ContextBridge holds one company's internal knowledge — expense policies, incident
runbooks, private Slack conversations. The single worst failure this system can have
is returning one customer's document to another customer. It is worse than downtime,
worse than a bad answer, and it is not recoverable by an apology.

The options are database-per-tenant, schema-per-tenant, or a shared schema with a
tenant column.

## Decision

**A shared schema with organization-level isolation.** The `organizations` table is
the tenant boundary; every tenant-owned row carries `organization_id`.

Three things enforce it:

1. **The column is not optional.** `organization_id` is `NOT NULL` with a foreign key
   and `ON DELETE CASCADE` on every tenant-owned table — `integrations`, `documents`,
   `chunks`, `sync_jobs`, `query_logs`, `sessions`. There is no valid row without a
   tenant.

2. **The tenant comes from the session, never from the request.** `AuthContext` is
   resolved server-side from a signed session cookie
   (`src/server/auth/session.ts`). No route accepts an `organizationId` parameter.
   A user cannot ask for another tenant's data because there is no field in which
   to ask.

3. **The filter is in the query, not applied to results.** Both arms of hybrid
   retrieval carry `organization_id` in their own `WHERE` clause, so another
   tenant's row is never a candidate — not fetched and then discarded. Mutations
   scope the same way: `requestSync` and `disconnectIntegration` look up by
   `(id, organization_id)`, so an id belonging to another tenant resolves to "not
   found" rather than acting on it.

Membership is re-read on every request rather than trusted from the cookie, so
revoking someone's access takes effect immediately instead of at session expiry.

## Rationale

**Why not database-per-tenant.** It is the strongest isolation and the wrong trade
here. It turns every migration into a fan-out across N databases, makes connection
pooling a per-tenant budget, and makes onboarding a provisioning operation rather
than an `INSERT`. For a product where a tenant may be a five-person company, the
per-tenant fixed cost dominates.

**Why not schema-per-tenant.** It carries most of database-per-tenant's migration
pain while giving up most of its isolation benefit — one compromised connection
still reaches every schema. It also breaks the single HNSW index (ADR 001) into N
smaller ones, which is worse for index maintenance and no better for query latency
at this scale.

**Why the shared schema is defensible.** The isolation guarantee reduces to one
invariant — *every query filters by `organization_id`* — which is small enough to
state, review and test. It is tested directly: two tenants hold contradictory
answers to the same question, and each is asserted to see only its own
(`tests/retrieval.test.ts`).

## Consequences

- **The invariant is only as good as its enforcement.** A single query that forgets
  the filter is a cross-tenant leak. Mitigations in place: the tenant is only ever
  available from `AuthContext`; retrieval is centralised in one module; the leak is
  covered by a test that would fail loudly. The honest statement of residual risk is
  that a future developer can still write an unfiltered query, and review is what
  catches it.
- **Postgres Row-Level Security is the next hardening step and is not yet enabled.**
  RLS would move enforcement from application discipline into the database, so an
  unfiltered query returns nothing rather than everything. It is deliberately
  deferred: it requires setting a per-request session variable on every connection,
  which interacts with pooling in ways worth doing carefully rather than quickly.
  The schema is already shaped for it — every table has the column RLS would key on.
- **Credentials are encrypted per row** (AES-256-GCM, `CREDENTIAL_SECRET`), so a
  database dump alone does not yield every tenant's OAuth tokens.
- **Noisy-neighbour effects are shared.** One tenant's large sync consumes worker
  capacity and connection-pool slots. Per-tenant rate limiting on the ask path
  exists; per-tenant ingestion fairness does not, and would be the next thing to
  add under real multi-tenant load.
- **A user belongs to an organization through `memberships`**, so multi-org users
  are already representable. The session stores the organization currently being
  acted as, and switching re-checks membership.
