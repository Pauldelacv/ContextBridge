                    ┌───────────────────┐
                    │      Notion       │
                    ├───────────────────┤
                    │   Google Drive    │
                    ├───────────────────┤
                    │       Slack       │
                    └─────────┬─────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │  Integration Layer  │
                   │                     │
                   │ OAuth               │
                   │ API Clients         │
                   │ Webhooks            │
                   │ Rate Limits         │
                   │ Retry Logic         │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │  Ingestion Pipeline │
                   │                     │
                   │ Fetch               │
                   │ Normalize           │
                   │ Deduplicate         │
                   │ Chunk               │
                   │ Embed               │
                   │ Store               │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ PostgreSQL          │
                   │ + pgvector          │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │   Retrieval Layer   │
                   │                     │
                   │ Metadata Filtering  │
                   │ Vector Search       │
                   │ Ranking             │
                   │ Source Citations    │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │        LLM          │
                   └──────────┬──────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Web Interface       │
                   │ Slack Interface     │
                   └─────────────────────┘