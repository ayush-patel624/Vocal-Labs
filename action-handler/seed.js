/**
 * seed.js — Database migration & seed runner
 * Run once before the app starts to set up the schema and demo data.
 * Safe to run multiple times (uses IF NOT EXISTS / ON CONFLICT DO NOTHING).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SQL = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================
-- Core Tables
-- =============================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    quota_limit INT NOT NULL DEFAULT 100,
    quota_used INT NOT NULL DEFAULT 0,
    quota_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, org_id)
);

CREATE TABLE IF NOT EXISTS workflows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by UUID REFERENCES users(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    step_type TEXT NOT NULL CHECK (step_type IN (
        'llm_call', 'http_request', 'db_write',
        'notify', 'conditional_branch', 'approval_gate'
    )),
    name TEXT NOT NULL DEFAULT '',
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workflow_id, step_order)
);

CREATE TABLE IF NOT EXISTS workflow_triggers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'manual', 'webhook', 'scheduled', 'database_event'
    )),
    config JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'paused', 'completed', 'failed'
    )),
    triggered_by UUID REFERENCES users(id),
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS step_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id UUID NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'skipped', 'paused'
    )),
    input JSONB DEFAULT '{}',
    output JSONB DEFAULT '{}',
    error TEXT,
    attempt_count INT NOT NULL DEFAULT 0,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- =============================================
-- Indexes (IF NOT EXISTS supported in PG 9.5+)
-- =============================================

CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_org ON org_members(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_order ON workflow_steps(workflow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_workflow_id ON workflow_triggers(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_step_runs_workflow_run_id ON step_runs(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_step_runs_status ON step_runs(status);

-- =============================================
-- View: Org Monthly Usage
-- =============================================

CREATE OR REPLACE VIEW org_monthly_usage AS
SELECT
    o.id AS org_id,
    o.name AS org_name,
    o.quota_limit,
    o.quota_used,
    COUNT(wr.id) AS total_runs_this_month,
    COALESCE(
        AVG(
            CASE WHEN wr.completed_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (wr.completed_at - wr.started_at))
            END
        ), 0
    )::NUMERIC(10,2) AS avg_run_duration_seconds,
    COALESCE(SUM(CASE WHEN wr.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_runs,
    COALESCE(SUM(CASE WHEN wr.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_runs
FROM organizations o
LEFT JOIN workflows w ON w.org_id = o.id
LEFT JOIN workflow_runs wr ON wr.workflow_id = w.id
    AND wr.started_at >= date_trunc('month', now())
GROUP BY o.id, o.name, o.quota_limit, o.quota_used;

-- =============================================
-- Trigger: Auto-update updated_at on workflows
-- =============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_workflows_updated_at ON workflows;
CREATE TRIGGER update_workflows_updated_at
    BEFORE UPDATE ON workflows
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- Seed Data (safe: ON CONFLICT DO NOTHING)
-- =============================================

INSERT INTO users (id, email, name, password_hash) VALUES
    ('a1000000-0000-0000-0000-000000000001', 'alice@orga.com', 'Alice', crypt('password123', gen_salt('bf'))),
    ('a1000000-0000-0000-0000-000000000002', 'bob@orga.com', 'Bob', crypt('password123', gen_salt('bf'))),
    ('a1000000-0000-0000-0000-000000000003', 'charlie@orga.com', 'Charlie', crypt('password123', gen_salt('bf'))),
    ('b1000000-0000-0000-0000-000000000001', 'dave@orgb.com', 'Dave', crypt('password123', gen_salt('bf'))),
    ('b1000000-0000-0000-0000-000000000002', 'eve@orgb.com', 'Eve', crypt('password123', gen_salt('bf')))
ON CONFLICT (email) DO NOTHING;

INSERT INTO organizations (id, name, quota_limit, quota_used) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'Alpha Corp', 100, 0),
    ('00000000-0000-0000-0000-00000000000b', 'Beta Inc', 50, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_members (user_id, org_id, role) VALUES
    ('a1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'owner'),
    ('a1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'editor'),
    ('a1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'viewer'),
    ('b1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'owner'),
    ('b1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'editor')
ON CONFLICT (user_id, org_id) DO NOTHING;

INSERT INTO workflows (id, org_id, name, description, created_by) VALUES
    ('w1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a',
     'AI Content Pipeline',
     'Generates content with AI, evaluates sentiment, and routes accordingly',
     'a1000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, name, config) VALUES
    ('s1000000-0000-0000-0000-000000000001', 'w1000000-0000-0000-0000-000000000001', 1, 'llm_call',
     'Generate Content',
     '{"prompt": "Write a short product review for a tech gadget. Include a clear sentiment (positive or negative) in your response.", "model": "default"}'),
    ('s1000000-0000-0000-0000-000000000002', 'w1000000-0000-0000-0000-000000000001', 2, 'conditional_branch',
     'Check Sentiment',
     '{"field": "response", "operator": "contains", "value": "positive", "skip_steps_if_false": 1}'),
    ('s1000000-0000-0000-0000-000000000003', 'w1000000-0000-0000-0000-000000000001', 3, 'http_request',
     'Post to API',
     '{"url": "https://httpbin.org/post", "method": "POST", "headers": {"Content-Type": "application/json"}}'),
    ('s1000000-0000-0000-0000-000000000004', 'w1000000-0000-0000-0000-000000000001', 4, 'approval_gate',
     'Manager Approval',
     '{"required_role": "owner", "message": "Please review the generated content before saving."}'),
    ('s1000000-0000-0000-0000-000000000005', 'w1000000-0000-0000-0000-000000000001', 5, 'db_write',
     'Save Result',
     '{"table": "workflow_runs", "fields": ["output"]}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_triggers (workflow_id, trigger_type, config) VALUES
    ('w1000000-0000-0000-0000-000000000001', 'manual', '{}'),
    ('w1000000-0000-0000-0000-000000000001', 'webhook', '{"secret": "whsec_alpha_pipeline_key"}')
ON CONFLICT DO NOTHING;

INSERT INTO workflows (id, org_id, name, description, created_by) VALUES
    ('w2000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b',
     'Data Processor', 'Simple data processing workflow',
     'b1000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, name, config) VALUES
    ('s2000000-0000-0000-0000-000000000001', 'w2000000-0000-0000-0000-000000000001', 1, 'http_request',
     'Fetch Data', '{"url": "https://httpbin.org/get", "method": "GET"}'),
    ('s2000000-0000-0000-0000-000000000002', 'w2000000-0000-0000-0000-000000000001', 2, 'llm_call',
     'Analyze Data', '{"prompt": "Summarize this data briefly", "model": "default"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_triggers (workflow_id, trigger_type, config) VALUES
    ('w2000000-0000-0000-0000-000000000001', 'manual', '{}')
ON CONFLICT DO NOTHING;
`;

async function seed() {
  console.log('[Seed] Connecting to database...');
  const client = await pool.connect();
  try {
    console.log('[Seed] Running migration & seed...');
    await client.query(SQL);
    console.log('[Seed] ✅ Database ready with schema and demo data.');
  } catch (err) {
    console.error('[Seed] ❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
