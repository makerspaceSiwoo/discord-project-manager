ALTER TABLE issue_links ADD COLUMN display_hash TEXT;
ALTER TABLE issue_links ADD COLUMN next_sync_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX issue_sync_due ON issue_links(project_id,next_sync_at);
