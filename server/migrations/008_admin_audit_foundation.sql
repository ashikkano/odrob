CREATE TABLE IF NOT EXISTS admin_audit_events (
  id            TEXT PRIMARY KEY,
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  auth_mode     TEXT NOT NULL,
  admin_role    TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  details_json  TEXT DEFAULT '{}',
  ip            TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at
  ON admin_audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action
  ON admin_audit_events(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_role
  ON admin_audit_events(admin_role, created_at DESC);