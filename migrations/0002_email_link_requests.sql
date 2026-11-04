CREATE TABLE link_requests(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  notion_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  UNIQUE(project_id, discord_id)
);
CREATE INDEX link_requests_project ON link_requests(project_id, expires);
