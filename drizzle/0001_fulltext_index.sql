-- The keyword arm of hybrid retrieval ranks with ts_rank_cd over an English
-- tsvector of chunk content. Without this expression index every query is a
-- sequential scan that recomputes to_tsvector for every chunk in the table.
CREATE INDEX IF NOT EXISTS "chunks_content_fts_idx"
  ON "chunks" USING gin (to_tsvector('english', "content"));
--> statement-breakpoint
-- Retrieval always filters by tenant first; pairing organization_id with the
-- document join column keeps that filter index-only.
CREATE INDEX IF NOT EXISTS "chunks_org_document_idx"
  ON "chunks" ("organization_id", "document_id");
