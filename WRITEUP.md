# Write-Up: Schema Reasoning, Permission Layers & Approval-Gate Implementation

## 1. Schema Design Reasoning

### Core Entities

The schema is organized around a multi-tenant organizational model:

**`organizations`** — Top-level tenant container. Each org has an independent usage quota (`quota_limit`, `quota_used`, `quota_period_start`) that resets monthly. Quotas are enforced before every workflow run, preventing resource abuse.

**`users`** — Authentication entities decoupled from organizations. A user can theoretically belong to multiple orgs (though in practice each demo user belongs to one). Passwords are hashed with bcrypt via PostgreSQL's `pgcrypto` extension.

**`org_members`** — The junction table that defines the relationship AND the authorization level. The `(user_id, org_id)` unique constraint prevents duplicate memberships. The `role` enum (`owner`, `editor`, `viewer`) drives both permission layers.

### Workflow Graph

**`workflows`** → **`workflow_steps`** → **`step_runs`** forms the execution hierarchy:

- **`workflow_steps`** uses `step_order` (unique per workflow) for sequential execution. The `step_type` enum constrains valid types. `config` is JSONB to accommodate type-specific configuration without schema sprawl — an LLM step stores a prompt, an HTTP step stores URL/method/headers, a conditional branch stores field/operator/value.

- **`workflow_triggers`** is separate from steps because triggers are "how a workflow starts" (orthogonal to "what a workflow does"). Multiple triggers can be attached to one workflow — e.g., a workflow that runs manually AND on webhook.

- **`workflow_runs`** captures each execution instance. The `status` field includes `paused` as a first-class state (not just "running + stuck") because approval gates are an expected, designed pause point. The `trigger_type` field records HOW the run was started, important for audit.

- **`step_runs`** is the most detailed table — it captures input, output, error, attempt count, and approval metadata per step per run. The `step_order` is denormalized here for efficient ordering without a join.

### Aggregation View

`org_monthly_usage` is a PostgreSQL view (not a materialized view — data freshness matters more than query speed at this scale) that joins `organizations` → `workflows` → `workflow_runs` to compute:
- Total runs this month
- Average run duration (completed runs only)
- Completed/failed run counts

This feeds the dashboard's usage statistics without requiring the frontend to compute aggregations.

---

## 2. Two-Layer Permission Enforcement

### Why Two Layers?

A single permission layer cannot cover all access patterns in this system:

1. **Data access** (who can read/write rows) — naturally fits database-level permissions
2. **Runtime decisions** (who can trigger a run, approve a gate) — requires application logic because the decision depends on execution state, not just row data

### Layer 1: Hasura Row-Level Permissions (Org + Role Scoping)

Every Hasura permission filter traverses relationships to verify:
1. The requesting user is a member of the relevant organization
2. Their role has the required access level

Example for `workflows` SELECT permission:
```json
{
  "filter": {
    "organization": {
      "org_members": {
        "user_id": { "_eq": "X-Hasura-User-Id" }
      }
    }
  }
}
```

This filter is evaluated by Hasura at the database level. Even if a user guesses a workflow ID from another org, the query returns empty — the row literally doesn't exist from their perspective.

For write operations, the filter is tighter:
```json
{
  "check": {
    "organization": {
      "org_members": {
        "user_id": { "_eq": "X-Hasura-User-Id" },
        "role": { "_in": ["owner", "editor"] }
      }
    }
  }
}
```

**Key design choice**: We use a single Hasura role (`user`) for all authenticated users, with org+role checks embedded in filters. This avoids the problem of a user being an `owner` in Org A and a `viewer` in Org B — if we used Hasura roles directly, we'd need a way to switch roles per-org, which JWT claims don't support cleanly.

### Layer 2: Action Handler Runtime Checks

The action handler enforces restrictions that can't be expressed as simple row-level permissions:

**Step type gating** (checked on workflow creation/edit):
```javascript
if (['db_write', 'notify'].includes(step.step_type) && role !== 'owner') {
  return res.status(403).json({ error: `Only owners can add ${step.step_type} steps` });
}
```
This can't be a Hasura permission because the restriction is on a column *value* (`step_type`), not on the column itself. Hasura permissions control which columns you can set, not which values.

**Approval gate** (checked at runtime):
```javascript
const role = await getUserOrgRole(userId, stepRun.org_id);
if (!role || role === 'viewer') {
  return res.status(403).json({ error: 'Only owners and editors can approve steps' });
}
```
This is a mid-execution decision: the system checks the approver's role in the *workflow's org*, not just whether they're authenticated. This prevents cross-org approval even if someone obtains a `step_run_id`.

**Quota enforcement**:
```javascript
if (workflow.quota_used >= workflow.quota_limit) {
  return res.status(429).json({ message: 'Organization quota exhausted' });
}
```
Checked before every run, incremented after completion. This is inherently an action-handler concern because it involves conditional logic + state mutation.

---

## 3. Approval-Gate Pause/Resume Implementation

### Flow

```
triggerWorkflowRun(workflow_id)
  │
  ├── Steps 1-3 execute sequentially
  │
  ├── Step 4: approval_gate
  │     ├── step_run.status = 'paused'
  │     ├── workflow_run.status = 'paused'
  │     └── Execution STOPS, function returns
  │
  │   (time passes, user reviews)
  │
  ├── approveStep(step_run_id)
  │     ├── Verify approver's org role (Layer 2 check)
  │     ├── step_run.status = 'completed'
  │     ├── step_run.approved_by = user_id
  │     ├── step_run.approved_at = now()
  │     └── resumeWorkflow(workflow_run_id)
  │           ├── Find last completed step order
  │           ├── Continue from next step
  │           └── Steps 5+ execute sequentially
  │
  └── All steps done → workflow_run.status = 'completed'
```

### Key Implementation Details

1. **Pause is explicit state, not a timeout**: When the executor hits an `approval_gate` step, it sets both the step_run and workflow_run to `paused` status, then *returns* from the function. No background process is waiting.

2. **Resume is a separate action**: `approveStep` is a distinct endpoint that:
   - Validates the approver's role (Layer 2)
   - Updates the approval metadata (who approved, when)
   - Calls `resumeWorkflow()` which finds where execution left off and continues

3. **State continuity**: The `resumeWorkflow` function queries the last completed step's output to pass as input to the next step, maintaining the data flow across the pause.

4. **Live visibility**: The frontend polls `step_runs` for the active workflow run. When a step enters `paused` state, the UI shows an approval prompt with a button (visible only to owners/editors). After approval, polling picks up the resumed execution.

5. **Async execution**: Both `triggerWorkflowRun` and `approveStep` use `setImmediate()` to run the executor asynchronously, returning immediately to the caller. This prevents HTTP timeouts on long-running workflows and allows the frontend to track progress via polling.

### Why Not WebSocket for Pause?

The pause is a database state change, not a WebSocket event. The frontend discovers paused state through polling (or could use Hasura subscriptions for true real-time). The approval action is a standard HTTP POST — no persistent connection needed. This keeps the architecture simpler and more resilient to disconnections.
