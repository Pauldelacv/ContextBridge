Create architecture decision records.

Include at minimum:

ADR 001 — PostgreSQL + pgvector

Explain why it was selected.

ADR 002 — Modular monolith

Explain why a microservice architecture would be unnecessary complexity at this stage.

ADR 003 — Asynchronous ingestion

Explain why ingestion uses background jobs.

ADR 004 — Multi-tenancy strategy

Explain organization-level isolation.

⸻

Coding Standards

Use:

* TypeScript strict mode
* Explicit types at boundaries
* Runtime validation
* Clear module boundaries
* Dependency injection where it provides value

Avoid:

* God services
* Giant route handlers
* Business logic inside React components
* Provider-specific logic scattered across the application
* Premature microservices
* Over-engineering

Prefer boring and understandable architecture.

⸻

Development Process

Do not attempt to build the entire application in one step.

Work in phases.

After each phase:

1. Verify the implementation
2. Run tests
3. Fix obvious issues
4. Update documentation if architecture changed

⸻

Implementation Phases

Phase 1 — Foundation

Build:

* Next.js project
* TypeScript
* Database
* pgvector
* Authentication
* Organizations
* Basic dashboard

Phase 2 — Core Data Model

Build:

* Integrations
* Documents
* Chunks
* Sync jobs
* Organization isolation

Phase 3 — Ingestion Framework

Build:

* Integration interface
* Normalization
* Deduplication
* Chunking
* Embedding abstraction

Phase 4 — First Integration

Implement Notion completely.

The first integration should establish the reusable pattern.

Phase 5 — Retrieval

Implement:

* Vector search
* Metadata filtering
* Tenant filtering
* Answer generation
* Source citations

Phase 6 — Synchronization

Implement:

* Background jobs
* Retries
* Idempotency
* Incremental updates

Phase 7 — Additional Integrations

Implement Google Drive and Slack.

Phase 8 — Slack Interface

Allow users to query ContextBridge directly from Slack.

Phase 9 — Production Polish

Implement:

* Observability
* Error states
* Tests
* Seed data
* Documentation