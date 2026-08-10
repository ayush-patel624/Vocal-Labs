const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
// Note: bcrypt npm package is NOT used — password hashing is handled via
// PostgreSQL pgcrypto extension (crypt / gen_salt) in SQL queries.
const { v4: uuidv4 } = require('uuid');
const { executeWorkflow, resumeWorkflow } = require('./executor');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
const JWT_SECRET = process.env.JWT_SECRET;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;

// =============================================
// Helpers
// =============================================

function generateJWT(user, orgMemberships) {
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    iat: Math.floor(Date.now() / 1000),
    'https://hasura.io/jwt/claims': {
      'x-hasura-allowed-roles': ['user'],
      'x-hasura-default-role': 'user',
      'x-hasura-user-id': user.id,
    }
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

function extractUserId(req) {
  // From Hasura Action call
  const sessionVars = req.body?.session_variables;
  if (sessionVars && sessionVars['x-hasura-user-id']) {
    return sessionVars['x-hasura-user-id'];
  }
  // From Authorization header
  const auth = req.headers.authorization;
  if (auth) {
    try {
      const token = auth.replace('Bearer ', '');
      const decoded = jwt.verify(token, JWT_SECRET);
      return decoded.sub;
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function getUserOrgRole(userId, orgId) {
  const result = await pool.query(
    'SELECT role FROM org_members WHERE user_id = $1 AND org_id = $2',
    [userId, orgId]
  );
  return result.rows[0]?.role || null;
}

async function getWorkflowOrgId(workflowId) {
  const result = await pool.query(
    'SELECT org_id FROM workflows WHERE id = $1',
    [workflowId]
  );
  return result.rows[0]?.org_id || null;
}

// =============================================
// Auth Endpoints
// =============================================

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const userResult = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Verify password using pgcrypto-generated bcrypt hash
    const passwordCheck = await pool.query(
      'SELECT (password_hash = crypt($1, password_hash)) AS valid FROM users WHERE id = $2',
      [password, user.id]
    );

    if (!passwordCheck.rows[0]?.valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get org memberships
    const memberships = await pool.query(
      `SELECT om.org_id, om.role, o.name as org_name 
       FROM org_members om JOIN organizations o ON o.id = om.org_id 
       WHERE om.user_id = $1`,
      [user.id]
    );

    const token = generateJWT(user, memberships.rows);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      organizations: memberships.rows
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/signup', async (req, res) => {
  try {
    const { name, email, password, orgName, role } = req.body;
    if (!name || !email || !password || !orgName || !role) {
      return res.status(400).json({ error: 'Name, email, password, orgName, and role required' });
    }

    if (!['owner', 'editor', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if user already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email is already registered' });
    }

    await pool.query('BEGIN');

    // Create user
    const userResult = await pool.query(
      `INSERT INTO users (email, name, password_hash) 
       VALUES ($1, $2, crypt($3, gen_salt('bf'))) RETURNING id, email, name`,
      [email, name, password]
    );
    const user = userResult.rows[0];

    // Find or create organization
    let orgResult = await pool.query('SELECT id, name FROM organizations WHERE lower(name) = lower($1)', [orgName]);
    let org;
    if (orgResult.rows.length > 0) {
      org = orgResult.rows[0];
    } else {
      const newOrg = await pool.query(
        `INSERT INTO organizations (name, quota_limit) VALUES ($1, 1000) RETURNING id, name`,
        [orgName]
      );
      org = newOrg.rows[0];
    }

    // Add user as member of the organization
    await pool.query(
      `INSERT INTO org_members (user_id, org_id, role) VALUES ($1, $2, $3)`,
      [user.id, org.id, role]
    );

    await pool.query('COMMIT');

    const memberships = [{
      org_id: org.id,
      role: role,
      org_name: org.name
    }];

    const token = generateJWT(user, memberships);

    res.json({
      token,
      user,
      organizations: memberships
    });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('[Auth] Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/auth/me', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userResult = await pool.query(
      'SELECT id, email, name FROM users WHERE id = $1', [userId]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const memberships = await pool.query(
      `SELECT om.org_id, om.role, o.name as org_name 
       FROM org_members om JOIN organizations o ON o.id = om.org_id 
       WHERE om.user_id = $1`, [userId]
    );

    res.json({
      user: userResult.rows[0],
      organizations: memberships.rows
    });
  } catch (error) {
    console.error('[Auth] /me error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================
// Hasura Action: triggerWorkflowRun
// =============================================

app.post('/trigger-workflow-run', async (req, res) => {
  try {
    const userId = extractUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { workflow_id } = req.body.input || req.body;
    if (!workflow_id) return res.status(400).json({ message: 'workflow_id required' });

    // Get workflow and verify org membership
    const workflowResult = await pool.query(
      'SELECT w.*, o.quota_limit, o.quota_used FROM workflows w JOIN organizations o ON o.id = w.org_id WHERE w.id = $1',
      [workflow_id]
    );

    if (workflowResult.rows.length === 0) {
      return res.status(404).json({ message: 'Workflow not found' });
    }

    const workflow = workflowResult.rows[0];

    // LAYER 1: Verify caller is owner or editor in the workflow's org
    const role = await getUserOrgRole(userId, workflow.org_id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ message: 'Only owners and editors can trigger workflows' });
    }

    // Check quota
    if (workflow.quota_used >= workflow.quota_limit) {
      return res.status(429).json({ message: 'Organization quota exhausted' });
    }

    // Get workflow steps
    const stepsResult = await pool.query(
      'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order',
      [workflow_id]
    );

    if (stepsResult.rows.length === 0) {
      return res.status(400).json({ message: 'Workflow has no steps' });
    }

    // LAYER 2: Check step-level permissions
    for (const step of stepsResult.rows) {
      if (['db_write', 'notify'].includes(step.step_type)) {
        // Only owners can have workflows with these step types
        // (but we still run them if they exist — the check is on creation)
      }
    }

    // Create workflow run
    const runId = uuidv4();
    await pool.query(
      `INSERT INTO workflow_runs (id, workflow_id, status, triggered_by, trigger_type, started_at) 
       VALUES ($1, $2, 'pending', $3, 'manual', now())`,
      [runId, workflow_id, userId]
    );

    // Execute workflow asynchronously
    setImmediate(async () => {
      try {
        await executeWorkflow(pool, runId, stepsResult.rows);
      } catch (error) {
        console.error('[Action] Workflow execution error:', error);
        await pool.query(
          `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
          [error.message, runId]
        );
      }
    });

    return res.json({
      workflow_run_id: runId,
      status: 'started'
    });

  } catch (error) {
    console.error('[Action] triggerWorkflowRun error:', error);
    return res.status(500).json({ message: error.message });
  }
});

// =============================================
// Hasura Action: approveStep
// =============================================

app.post('/approve-step', async (req, res) => {
  try {
    const userId = extractUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { step_run_id } = req.body.input || req.body;
    if (!step_run_id) return res.status(400).json({ message: 'step_run_id required' });

    // Get step run details
    const stepRunResult = await pool.query(
      `SELECT sr.*, wr.workflow_id, w.org_id 
       FROM step_runs sr 
       JOIN workflow_runs wr ON wr.id = sr.workflow_run_id 
       JOIN workflows w ON w.id = wr.workflow_id 
       WHERE sr.id = $1`,
      [step_run_id]
    );

    if (stepRunResult.rows.length === 0) {
      return res.status(404).json({ message: 'Step run not found' });
    }

    const stepRun = stepRunResult.rows[0];

    if (stepRun.status !== 'paused') {
      return res.status(400).json({ message: 'Step is not in paused state' });
    }

    // LAYER 2: Verify approver is owner or editor in the workflow's org
    const role = await getUserOrgRole(userId, stepRun.org_id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ message: 'Only owners and editors can approve steps' });
    }

    // Mark step as approved/completed
    await pool.query(
      `UPDATE step_runs SET status = 'completed', approved_by = $1, approved_at = now(), completed_at = now() WHERE id = $2`,
      [userId, step_run_id]
    );

    // Resume workflow execution asynchronously
    setImmediate(async () => {
      try {
        await resumeWorkflow(pool, stepRun.workflow_run_id);
      } catch (error) {
        console.error('[Action] Resume workflow error:', error);
        await pool.query(
          `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
          [error.message, stepRun.workflow_run_id]
        );
      }
    });

    return res.json({
      success: true,
      message: 'Step approved, workflow resuming'
    });

  } catch (error) {
    console.error('[Action] approveStep error:', error);
    return res.status(500).json({ message: error.message });
  }
});

// =============================================
// Hasura Action: rejectStep
// =============================================

app.post('/reject-step', async (req, res) => {
  try {
    const userId = extractUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { step_run_id } = req.body.input || req.body;
    if (!step_run_id) return res.status(400).json({ message: 'step_run_id required' });

    // Get step run details
    const stepRunResult = await pool.query(
      `SELECT sr.*, wr.workflow_id, w.org_id 
       FROM step_runs sr 
       JOIN workflow_runs wr ON wr.id = sr.workflow_run_id 
       JOIN workflows w ON w.id = wr.workflow_id 
       WHERE sr.id = $1`,
      [step_run_id]
    );

    if (stepRunResult.rows.length === 0) {
      return res.status(404).json({ message: 'Step run not found' });
    }

    const stepRun = stepRunResult.rows[0];

    if (stepRun.status !== 'paused') {
      return res.status(400).json({ message: 'Step is not in paused state' });
    }

    // LAYER 2: Verify approver is owner or editor in the workflow's org
    const role = await getUserOrgRole(userId, stepRun.org_id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ message: 'Only owners and editors can reject steps' });
    }

    // Mark step as failed/rejected
    await pool.query(
      `UPDATE step_runs SET status = 'failed', error = 'Rejected by user', approved_by = $1, approved_at = now(), completed_at = now() WHERE id = $2`,
      [userId, step_run_id]
    );

    // Mark workflow as failed
    await pool.query(
      `UPDATE workflow_runs SET status = 'failed', error = 'Workflow rejected at approval gate', completed_at = now() WHERE id = $1`,
      [stepRun.workflow_run_id]
    );

    return res.json({
      success: true,
      message: 'Step rejected, workflow stopped'
    });

  } catch (error) {
    console.error('[Action] rejectStep error:', error);
    return res.status(500).json({ message: error.message });
  }
});

// =============================================
// Webhook Trigger Endpoint
// =============================================

app.post('/webhook/:workflow_id', async (req, res) => {
  try {
    const { workflow_id } = req.params;
    const webhookSecret = req.headers['x-webhook-secret'] || req.query.secret;

    // Verify workflow exists and has a webhook trigger
    const triggerResult = await pool.query(
      `SELECT wt.*, w.org_id FROM workflow_triggers wt 
       JOIN workflows w ON w.id = wt.workflow_id 
       WHERE wt.workflow_id = $1 AND wt.trigger_type = 'webhook' AND wt.is_active = true`,
      [workflow_id]
    );

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook trigger not found' });
    }

    const trigger = triggerResult.rows[0];

    // Verify webhook secret if configured
    if (trigger.config?.secret && trigger.config.secret !== webhookSecret) {
      return res.status(403).json({ error: 'Invalid webhook secret' });
    }

    // Check org quota
    const orgResult = await pool.query(
      'SELECT quota_limit, quota_used FROM organizations WHERE id = $1',
      [trigger.org_id]
    );

    if (orgResult.rows[0].quota_used >= orgResult.rows[0].quota_limit) {
      return res.status(429).json({ error: 'Organization quota exhausted' });
    }

    // Get workflow steps
    const stepsResult = await pool.query(
      'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order',
      [workflow_id]
    );

    // Create workflow run
    const runId = uuidv4();
    await pool.query(
      `INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, started_at) 
       VALUES ($1, $2, 'pending', 'webhook', now())`,
      [runId, workflow_id]
    );

    // Execute asynchronously
    setImmediate(async () => {
      try {
        await executeWorkflow(pool, runId, stepsResult.rows);
      } catch (error) {
        console.error('[Webhook] Workflow execution error:', error);
        await pool.query(
          `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
          [error.message, runId]
        );
      }
    });

    return res.json({
      workflow_run_id: runId,
      status: 'triggered',
      message: 'Workflow started via webhook'
    });

  } catch (error) {
    console.error('[Webhook] Error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// =============================================
// Scheduled Trigger Endpoint (called by cron)
// =============================================

app.post('/scheduled-trigger', async (req, res) => {
  try {
    // Verify admin secret for scheduled triggers
    const adminSecret = req.headers['x-hasura-admin-secret'];
    if (adminSecret !== HASURA_ADMIN_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { workflow_id } = req.body;

    // Get workflow steps
    const stepsResult = await pool.query(
      'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order',
      [workflow_id]
    );

    const runId = uuidv4();
    await pool.query(
      `INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, started_at) 
       VALUES ($1, $2, 'pending', 'scheduled', now())`,
      [runId, workflow_id]
    );

    setImmediate(async () => {
      try {
        await executeWorkflow(pool, runId, stepsResult.rows);
      } catch (error) {
        await pool.query(
          `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
          [error.message, runId]
        );
      }
    });

    return res.json({ workflow_run_id: runId, status: 'triggered' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// =============================================
// Event Trigger Endpoint (database events)
// =============================================

app.post('/event-trigger', async (req, res) => {
  try {
    const payload = req.body;
    const tableName = payload?.table?.name;
    const event = payload?.event;

    console.log(`[EventTrigger] Table: ${tableName}, Op: ${event?.op}`);

    // Find workflows with database_event triggers watching this table
    const triggerResult = await pool.query(
      `SELECT wt.workflow_id FROM workflow_triggers wt 
       WHERE wt.trigger_type = 'database_event' AND wt.is_active = true
       AND wt.config->>'watched_table' = $1`,
      [tableName]
    );

    for (const trigger of triggerResult.rows) {
      const stepsResult = await pool.query(
        'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order',
        [trigger.workflow_id]
      );

      const runId = uuidv4();
      await pool.query(
        `INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, started_at) 
         VALUES ($1, $2, 'pending', 'database_event', now())`,
        [runId, trigger.workflow_id]
      );

      setImmediate(async () => {
        try {
          await executeWorkflow(pool, runId, stepsResult.rows);
        } catch (error) {
          await pool.query(
            `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
            [error.message, runId]
          );
        }
      });
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// =============================================
// Workflow CRUD (for frontend, bypasses Hasura for simplicity)
// =============================================

app.get('/api/workflows', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const orgId = req.query.org_id;
  if (!orgId) return res.status(400).json({ error: 'org_id required' });

  // Verify membership
  const role = await getUserOrgRole(userId, orgId);
  if (!role) return res.status(403).json({ error: 'Not a member of this organization' });

  const result = await pool.query(
    `SELECT w.*, 
       (SELECT json_agg(ws ORDER BY ws.step_order) FROM workflow_steps ws WHERE ws.workflow_id = w.id) as steps,
       (SELECT json_agg(wt) FROM workflow_triggers wt WHERE wt.workflow_id = w.id) as triggers,
       (SELECT json_agg(wr ORDER BY wr.started_at DESC)
        FROM (SELECT * FROM workflow_runs WHERE workflow_id = w.id ORDER BY started_at DESC LIMIT 5) wr
       ) as recent_runs
     FROM workflows w 
     WHERE w.org_id = $1 
     ORDER BY w.updated_at DESC`,
    [orgId]
  );

  res.json({ workflows: result.rows, role });
});

app.get('/api/workflows/:id', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const result = await pool.query(
    `SELECT w.*, o.name as org_name, o.quota_limit, o.quota_used
     FROM workflows w JOIN organizations o ON o.id = w.org_id WHERE w.id = $1`,
    [req.params.id]
  );

  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

  const workflow = result.rows[0];
  const role = await getUserOrgRole(userId, workflow.org_id);
  if (!role) return res.status(403).json({ error: 'Access denied' });

  const steps = await pool.query(
    'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order', [req.params.id]
  );
  const triggers = await pool.query(
    'SELECT * FROM workflow_triggers WHERE workflow_id = $1', [req.params.id]
  );
  const runs = await pool.query(
    'SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 10', [req.params.id]
  );

  res.json({
    workflow: { ...workflow, steps: steps.rows, triggers: triggers.rows, recent_runs: runs.rows },
    role
  });
});

app.post('/api/workflows', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { org_id, name, description, steps, triggers } = req.body;

  const role = await getUserOrgRole(userId, org_id);
  if (!role || role === 'viewer') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // LAYER 2: Check step-level permissions
  if (steps) {
    for (const step of steps) {
      if (['db_write', 'notify'].includes(step.step_type) && role !== 'owner') {
        return res.status(403).json({ error: `Only owners can add ${step.step_type} steps` });
      }
    }
  }

  if (triggers) {
    for (const trigger of triggers) {
      if (['webhook', 'database_event'].includes(trigger.trigger_type) && role !== 'owner') {
        return res.status(403).json({ error: `Only owners can add ${trigger.trigger_type} triggers` });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const workflowId = uuidv4();
    await client.query(
      'INSERT INTO workflows (id, org_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5)',
      [workflowId, org_id, name, description || '', userId]
    );

    if (steps && steps.length > 0) {
      for (const step of steps) {
        await client.query(
          'INSERT INTO workflow_steps (workflow_id, step_order, step_type, name, config) VALUES ($1, $2, $3, $4, $5)',
          [workflowId, step.step_order, step.step_type, step.name || '', JSON.stringify(step.config || {})]
        );
      }
    }

    if (triggers && triggers.length > 0) {
      for (const trigger of triggers) {
        await client.query(
          'INSERT INTO workflow_triggers (workflow_id, trigger_type, config) VALUES ($1, $2, $3)',
          [workflowId, trigger.trigger_type, JSON.stringify(trigger.config || {})]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ workflow_id: workflowId, message: 'Workflow created' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.put('/api/workflows/:id', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { name, description, steps, triggers } = req.body;

  const orgId = await getWorkflowOrgId(req.params.id);
  if (!orgId) return res.status(404).json({ error: 'Workflow not found' });

  const role = await getUserOrgRole(userId, orgId);
  if (!role || role === 'viewer') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // LAYER 2: Check step-level permissions
  if (steps) {
    for (const step of steps) {
      if (['db_write', 'notify'].includes(step.step_type) && role !== 'owner') {
        return res.status(403).json({ error: `Only owners can add ${step.step_type} steps` });
      }
    }
  }

  if (triggers) {
    for (const trigger of triggers) {
      if (['webhook', 'database_event'].includes(trigger.trigger_type) && role !== 'owner') {
        return res.status(403).json({ error: `Only owners can add ${trigger.trigger_type} triggers` });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (name || description !== undefined) {
      await client.query(
        'UPDATE workflows SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3',
        [name, description, req.params.id]
      );
    }

    if (steps) {
      const existingIds = steps.filter(s => s.id).map(s => s.id);
      if (existingIds.length > 0) {
        await client.query(`DELETE FROM workflow_steps WHERE workflow_id = $1 AND id != ALL($2::uuid[])`, [req.params.id, existingIds]);
      } else {
        await client.query('DELETE FROM workflow_steps WHERE workflow_id = $1', [req.params.id]);
      }

      for (const step of steps) {
        if (step.id) {
          await client.query(
            'UPDATE workflow_steps SET step_order = $1, step_type = $2, name = $3, config = $4 WHERE id = $5',
            [step.step_order, step.step_type, step.name || '', JSON.stringify(step.config || {}), step.id]
          );
        } else {
          await client.query(
            'INSERT INTO workflow_steps (workflow_id, step_order, step_type, name, config) VALUES ($1, $2, $3, $4, $5)',
            [req.params.id, step.step_order, step.step_type, step.name || '', JSON.stringify(step.config || {})]
          );
        }
      }
    }

    if (triggers) {
      const existingIds = triggers.filter(t => t.id).map(t => t.id);
      if (existingIds.length > 0) {
        await client.query(`DELETE FROM workflow_triggers WHERE workflow_id = $1 AND id != ALL($2::uuid[])`, [req.params.id, existingIds]);
      } else {
        await client.query('DELETE FROM workflow_triggers WHERE workflow_id = $1', [req.params.id]);
      }

      for (const trigger of triggers) {
        if (trigger.id) {
          await client.query(
            'UPDATE workflow_triggers SET trigger_type = $1, config = $2 WHERE id = $3',
            [trigger.trigger_type, JSON.stringify(trigger.config || {}), trigger.id]
          );
        } else {
          await client.query(
            'INSERT INTO workflow_triggers (workflow_id, trigger_type, config) VALUES ($1, $2, $3)',
            [req.params.id, trigger.trigger_type, JSON.stringify(trigger.config || {})]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Workflow updated' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/workflows/:id', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const orgId = await getWorkflowOrgId(req.params.id);
  if (!orgId) return res.status(404).json({ error: 'Workflow not found' });

  const role = await getUserOrgRole(userId, orgId);
  if (role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can delete workflows' });
  }

  await pool.query('DELETE FROM workflows WHERE id = $1', [req.params.id]);
  res.json({ message: 'Workflow deleted' });
});

// =============================================
// Run Endpoints
// =============================================

app.get('/api/runs/:id', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const result = await pool.query(
    `SELECT wr.*, w.org_id, w.name as workflow_name
     FROM workflow_runs wr 
     JOIN workflows w ON w.id = wr.workflow_id 
     WHERE wr.id = $1`,
    [req.params.id]
  );

  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

  const run = result.rows[0];
  const role = await getUserOrgRole(userId, run.org_id);
  if (!role) return res.status(403).json({ error: 'Access denied' });

  const stepRuns = await pool.query(
    `SELECT sr.*, ws.step_type, ws.name as step_name, ws.config as step_config
     FROM step_runs sr
     JOIN workflow_steps ws ON ws.id = sr.workflow_step_id
     WHERE sr.workflow_run_id = $1
     ORDER BY sr.step_order`,
    [req.params.id]
  );

  res.json({ run, step_runs: stepRuns.rows, role });
});

app.get('/api/runs', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const workflowId = req.query.workflow_id;
  if (!workflowId) return res.status(400).json({ error: 'workflow_id required' });

  const orgId = await getWorkflowOrgId(workflowId);
  if (!orgId) return res.status(404).json({ error: 'Workflow not found' });

  const role = await getUserOrgRole(userId, orgId);
  if (!role) return res.status(403).json({ error: 'Access denied' });

  const result = await pool.query(
    `SELECT wr.*, 
       (SELECT COUNT(*) FROM step_runs sr WHERE sr.workflow_run_id = wr.id AND sr.status = 'completed') as completed_steps,
       (SELECT COUNT(*) FROM step_runs sr WHERE sr.workflow_run_id = wr.id) as total_steps
     FROM workflow_runs wr
     WHERE wr.workflow_id = $1
     ORDER BY wr.started_at DESC
     LIMIT 20`,
    [workflowId]
  );

  res.json({ runs: result.rows, role });
});

// =============================================
// Org Endpoints
// =============================================

app.get('/api/org/:id/usage', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const role = await getUserOrgRole(userId, req.params.id);
  if (!role) return res.status(403).json({ error: 'Access denied' });

  const result = await pool.query(
    'SELECT * FROM org_monthly_usage WHERE org_id = $1',
    [req.params.id]
  );

  res.json(result.rows[0] || {});
});

app.get('/api/org/:id/members', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const role = await getUserOrgRole(userId, req.params.id);
  if (!role) return res.status(403).json({ error: 'Access denied' });

  const result = await pool.query(
    `SELECT om.id, om.role, u.id as user_id, u.email, u.name
     FROM org_members om JOIN users u ON u.id = om.user_id
     WHERE om.org_id = $1`,
    [req.params.id]
  );

  res.json({ members: result.rows, your_role: role });
});

// =============================================
// Step-level trigger run (directly from frontend)
// =============================================

app.post('/api/trigger-run', async (req, res) => {
  try {
    const userId = extractUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { workflow_id } = req.body;
    if (!workflow_id) return res.status(400).json({ error: 'workflow_id required' });

    const workflowResult = await pool.query(
      'SELECT w.*, o.quota_limit, o.quota_used FROM workflows w JOIN organizations o ON o.id = w.org_id WHERE w.id = $1',
      [workflow_id]
    );

    if (workflowResult.rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });

    const workflow = workflowResult.rows[0];
    const role = await getUserOrgRole(userId, workflow.org_id);

    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Only owners and editors can trigger workflows' });
    }

    if (workflow.quota_used >= workflow.quota_limit) {
      return res.status(429).json({ error: 'Organization quota exhausted' });
    }

    const stepsResult = await pool.query(
      'SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order', [workflow_id]
    );

    if (stepsResult.rows.length === 0) {
      return res.status(400).json({ error: 'Workflow has no steps' });
    }

    const runId = uuidv4();
    await pool.query(
      `INSERT INTO workflow_runs (id, workflow_id, status, triggered_by, trigger_type, started_at) 
       VALUES ($1, $2, 'pending', $3, 'manual', now())`,
      [runId, workflow_id, userId]
    );

    setImmediate(async () => {
      try {
        await executeWorkflow(pool, runId, stepsResult.rows);
      } catch (error) {
        console.error('[TriggerRun] Error:', error);
        await pool.query(
          `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
          [error.message, runId]
        );
      }
    });

    res.json({ workflow_run_id: runId, status: 'started' });
  } catch (error) {
    console.error('[TriggerRun] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/approve-step', async (req, res) => {
  try {
    const userId = extractUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { step_run_id } = req.body;
    if (!step_run_id) return res.status(400).json({ error: 'step_run_id required' });

    const stepRunResult = await pool.query(
      `SELECT sr.*, wr.workflow_id, w.org_id 
       FROM step_runs sr 
       JOIN workflow_runs wr ON wr.id = sr.workflow_run_id 
       JOIN workflows w ON w.id = wr.workflow_id 
       WHERE sr.id = $1`,
      [step_run_id]
    );

    if (stepRunResult.rows.length === 0) return res.status(404).json({ error: 'Step run not found' });

    const stepRun = stepRunResult.rows[0];
    if (stepRun.status !== 'paused') return res.status(400).json({ error: 'Step is not paused' });

    // LAYER 2: Runtime check — only owner/editor can approve
    const role = await getUserOrgRole(userId, stepRun.org_id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Only owners and editors can approve steps' });
    }

    await pool.query(
      `UPDATE step_runs SET status = 'completed', approved_by = $1, approved_at = now(), completed_at = now() WHERE id = $2`,
      [userId, step_run_id]
    );

    setImmediate(async () => {
      try {
        await resumeWorkflow(pool, stepRun.workflow_run_id);
      } catch (error) {
        console.error('[ApproveStep] Resume error:', error);
        await pool.query(
          `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
          [error.message, stepRun.workflow_run_id]
        );
      }
    });

    res.json({ success: true, message: 'Step approved, workflow resuming' });
  } catch (error) {
    console.error('[ApproveStep] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reject-step', async (req, res) => {
  try {
    const userId = extractUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { step_run_id } = req.body;
    if (!step_run_id) return res.status(400).json({ error: 'step_run_id required' });

    const stepRunResult = await pool.query(
      `SELECT sr.*, wr.workflow_id, w.org_id 
       FROM step_runs sr 
       JOIN workflow_runs wr ON wr.id = sr.workflow_run_id 
       JOIN workflows w ON w.id = wr.workflow_id 
       WHERE sr.id = $1`,
      [step_run_id]
    );

    if (stepRunResult.rows.length === 0) return res.status(404).json({ error: 'Step run not found' });

    const stepRun = stepRunResult.rows[0];
    if (stepRun.status !== 'paused') return res.status(400).json({ error: 'Step is not paused' });

    // LAYER 2: Runtime check — only owner/editor can reject
    const role = await getUserOrgRole(userId, stepRun.org_id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Only owners and editors can reject steps' });
    }

    await pool.query(
      `UPDATE step_runs SET status = 'failed', error = 'Rejected by user', approved_by = $1, approved_at = now(), completed_at = now() WHERE id = $2`,
      [userId, step_run_id]
    );

    await pool.query(
      `UPDATE workflow_runs SET status = 'failed', error = 'Workflow rejected at approval gate', completed_at = now() WHERE id = $1`,
      [stepRun.workflow_run_id]
    );

    res.json({ success: true, message: 'Step rejected, workflow stopped' });
  } catch (error) {
    console.error('[RejectStep] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// Health Check
// =============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =============================================
// Start Server & Scheduler
// =============================================

let lastCheckedMinute = null;
setInterval(async () => {
  try {
    const d = new Date();
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    const istDate = new Date(utc + (3600000 * 5.5));
    const hh = String(istDate.getHours()).padStart(2, '0');
    const mm = String(istDate.getMinutes()).padStart(2, '0');
    const currentMinuteStr = `${hh}:${mm}`;

    if (lastCheckedMinute === currentMinuteStr) return; // Prevent double trigger in same minute
    lastCheckedMinute = currentMinuteStr;

    // Find scheduled triggers matching this time
    const triggerResult = await pool.query(
      `SELECT wt.*, w.org_id FROM workflow_triggers wt 
       JOIN workflows w ON w.id = wt.workflow_id 
       WHERE wt.trigger_type = 'scheduled' AND wt.is_active = true`
    );

    for (const trigger of triggerResult.rows) {
      if (trigger.config?.time === currentMinuteStr) {
        // Trigger the workflow
        const orgResult = await pool.query('SELECT quota_limit, quota_used FROM organizations WHERE id = $1', [trigger.org_id]);
        if (orgResult.rows[0].quota_used >= orgResult.rows[0].quota_limit) {
          console.log(`[Scheduler] Skipping workflow ${trigger.workflow_id} due to quota limit`);
          continue;
        }

        const stepsResult = await pool.query('SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order', [trigger.workflow_id]);
        if (stepsResult.rows.length === 0) continue;

        const runId = uuidv4(); // use the top-level imported uuidv4, not inline require
        await pool.query(
          `INSERT INTO workflow_runs (id, workflow_id, status, triggered_by, trigger_type, started_at) 
           VALUES ($1, $2, 'pending', NULL, 'scheduled', now())`,
          [runId, trigger.workflow_id]
        );

        setImmediate(async () => {
          try {
            await executeWorkflow(pool, runId, stepsResult.rows);
          } catch (error) {
            console.error('[Scheduler] Workflow execution error:', error);
            await pool.query(`UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`, [error.message, runId]);
          }
        });
        console.log(`[Scheduler] Triggered workflow ${trigger.workflow_id} at ${currentMinuteStr} IST`);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error:', error);
  }
}, 10000); // Check every 10 seconds

// =============================================
// Auto-seed DB on startup (safe — idempotent)
// Runs schema + demo data before server starts.
// Uses IF NOT EXISTS & ON CONFLICT DO NOTHING.
// =============================================

const SEED_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL, quota_limit INT NOT NULL DEFAULT 100,
  quota_used INT NOT NULL DEFAULT 0,
  quota_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, org_id)
);
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT DEFAULT '',
  created_by UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN ('llm_call','http_request','db_write','notify','conditional_branch','approval_gate')),
  name TEXT NOT NULL DEFAULT '', config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workflow_id, step_order)
);
CREATE TABLE IF NOT EXISTS workflow_triggers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','webhook','scheduled','database_event')),
  config JSONB NOT NULL DEFAULT '{}', is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','paused','completed','failed')),
  triggered_by UUID REFERENCES users(id), trigger_type TEXT NOT NULL DEFAULT 'manual',
  error TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS step_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id UUID NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','skipped','paused')),
  input JSONB DEFAULT '{}', output JSONB DEFAULT '{}', error TEXT,
  attempt_count INT NOT NULL DEFAULT 0, approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_step_runs_workflow_run_id ON step_runs(workflow_run_id);

CREATE OR REPLACE VIEW org_monthly_usage AS
SELECT o.id AS org_id, o.name AS org_name, o.quota_limit, o.quota_used,
  COUNT(wr.id) AS total_runs_this_month,
  COALESCE(AVG(CASE WHEN wr.completed_at IS NOT NULL THEN EXTRACT(EPOCH FROM (wr.completed_at - wr.started_at)) END), 0)::NUMERIC(10,2) AS avg_run_duration_seconds,
  COALESCE(SUM(CASE WHEN wr.status='completed' THEN 1 ELSE 0 END),0) AS completed_runs,
  COALESCE(SUM(CASE WHEN wr.status='failed' THEN 1 ELSE 0 END),0) AS failed_runs
FROM organizations o
LEFT JOIN workflows w ON w.org_id = o.id
LEFT JOIN workflow_runs wr ON wr.workflow_id = w.id AND wr.started_at >= date_trunc('month', now())
GROUP BY o.id, o.name, o.quota_limit, o.quota_used;

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS update_workflows_updated_at ON workflows;
CREATE TRIGGER update_workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO users (id,email,name,password_hash) VALUES
  ('a1000000-0000-0000-0000-000000000001','alice@orga.com','Alice',crypt('password123',gen_salt('bf'))),
  ('a1000000-0000-0000-0000-000000000002','bob@orga.com','Bob',crypt('password123',gen_salt('bf'))),
  ('a1000000-0000-0000-0000-000000000003','charlie@orga.com','Charlie',crypt('password123',gen_salt('bf'))),
  ('b1000000-0000-0000-0000-000000000001','dave@orgb.com','Dave',crypt('password123',gen_salt('bf'))),
  ('b1000000-0000-0000-0000-000000000002','eve@orgb.com','Eve',crypt('password123',gen_salt('bf')))
ON CONFLICT (email) DO NOTHING;

INSERT INTO organizations (id,name,quota_limit,quota_used) VALUES
  ('00000000-0000-0000-0000-00000000000a','Alpha Corp',100,0),
  ('00000000-0000-0000-0000-00000000000b','Beta Inc',50,0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_members (user_id,org_id,role) VALUES
  ('a1000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','owner'),
  ('a1000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','editor'),
  ('a1000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-00000000000a','viewer'),
  ('b1000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000b','owner'),
  ('b1000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','editor')
ON CONFLICT (user_id,org_id) DO NOTHING;

INSERT INTO workflows (id,org_id,name,description,created_by) VALUES
  ('w1000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','AI Content Pipeline','Generates content with AI, evaluates sentiment, and routes accordingly','a1000000-0000-0000-0000-000000000001'),
  ('w2000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000b','Data Processor','Simple data processing workflow','b1000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_steps (id,workflow_id,step_order,step_type,name,config) VALUES
  ('s1000000-0000-0000-0000-000000000001','w1000000-0000-0000-0000-000000000001',1,'llm_call','Generate Content','{"prompt":"Write a short product review for a tech gadget. Include a clear sentiment (positive or negative).","model":"default"}'),
  ('s1000000-0000-0000-0000-000000000002','w1000000-0000-0000-0000-000000000001',2,'conditional_branch','Check Sentiment','{"field":"response","operator":"contains","value":"positive","skip_steps_if_false":1}'),
  ('s1000000-0000-0000-0000-000000000003','w1000000-0000-0000-0000-000000000001',3,'http_request','Post to API','{"url":"https://httpbin.org/post","method":"POST","headers":{"Content-Type":"application/json"}}'),
  ('s1000000-0000-0000-0000-000000000004','w1000000-0000-0000-0000-000000000001',4,'approval_gate','Manager Approval','{"required_role":"owner","message":"Please review the generated content before saving."}'),
  ('s1000000-0000-0000-0000-000000000005','w1000000-0000-0000-0000-000000000001',5,'db_write','Save Result','{"table":"workflow_runs","fields":["output"]}'),
  ('s2000000-0000-0000-0000-000000000001','w2000000-0000-0000-0000-000000000001',1,'http_request','Fetch Data','{"url":"https://httpbin.org/get","method":"GET"}'),
  ('s2000000-0000-0000-0000-000000000002','w2000000-0000-0000-0000-000000000001',2,'llm_call','Analyze Data','{"prompt":"Summarize this data briefly","model":"default"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_triggers (workflow_id,trigger_type,config) VALUES
  ('w1000000-0000-0000-0000-000000000001','manual','{}'),
  ('w1000000-0000-0000-0000-000000000001','webhook','{"secret":"whsec_alpha_pipeline_key"}'),
  ('w2000000-0000-0000-0000-000000000001','manual','{}')
ON CONFLICT DO NOTHING;
`;

async function startServer() {
  // Run DB seed before starting the server
  console.log('[Startup] Running database migration & seed...');
  const seedClient = await pool.connect();
  try {
    await seedClient.query(SEED_SQL);
    console.log('[Startup] ✅ Database ready.');
  } catch (err) {
    // Non-fatal: tables likely already exist from a previous run
    console.warn('[Startup] ⚠️  Seed warning (may already be seeded):', err.message);
  } finally {
    seedClient.release();
  }

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ActionHandler] Running on port ${PORT}`);
    console.log(`[ActionHandler] LLM Provider: ${process.env.LLM_PROVIDER || 'stub'}`);
  });
}

startServer().catch((err) => {
  console.error('[Startup] Fatal error:', err);
  process.exit(1);
});
