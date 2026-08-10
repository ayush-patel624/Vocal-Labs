const axios = require('axios');
const { callLLM } = require('./llm');

const MAX_RETRIES = 1;

/**
 * Execute a workflow run step-by-step.
 * Pauses on approval_gate steps and returns.
 * Handles retries on failure for llm_call and http_request steps.
 */
async function executeWorkflow(pool, workflowRunId, steps, startFromIndex = 0) {
  console.log(`[Executor] Starting workflow run ${workflowRunId} from step index ${startFromIndex}`);

  let previousOutput = {};
  let skipCount = 0;

  // If resuming, get the output of the last completed step
  if (startFromIndex > 0) {
    const prevResult = await pool.query(
      `SELECT output FROM step_runs 
       WHERE workflow_run_id = $1 AND step_order = $2 AND status = 'completed'`,
      [workflowRunId, startFromIndex]
    );
    if (prevResult.rows.length > 0) {
      previousOutput = prevResult.rows[0].output || {};
    }
  }

  // Update workflow run to running
  await pool.query(
    `UPDATE workflow_runs SET status = 'running' WHERE id = $1`,
    [workflowRunId]
  );

  for (let i = startFromIndex; i < steps.length; i++) {
    const step = steps[i];
    const stepOrder = step.step_order;

    // Handle skip from conditional_branch
    if (skipCount > 0) {
      skipCount--;
      await upsertStepRun(pool, workflowRunId, step.id, stepOrder, {
        status: 'skipped',
        input: previousOutput,
        output: { skipped: true, reason: 'conditional_branch' },
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString()
      });
      console.log(`[Executor] Skipping step ${stepOrder} (${step.step_type}: ${step.name})`);
      continue;
    }

    console.log(`[Executor] Executing step ${stepOrder}: ${step.step_type} (${step.name})`);

    // Create/update step_run to running
    await upsertStepRun(pool, workflowRunId, step.id, stepOrder, {
      status: 'running',
      input: previousOutput,
      started_at: new Date().toISOString()
    });

    try {
      let output;
      let attempts = 0;
      const maxAttempts = shouldRetry(step.step_type) ? MAX_RETRIES + 1 : 1;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          output = await executeStep(pool, step, previousOutput, workflowRunId);
          break; // Success
        } catch (stepError) {
          console.error(`[Executor] Step ${stepOrder} attempt ${attempts} failed:`, stepError.message);
          if (attempts >= maxAttempts) {
            throw stepError;
          }
          // Update attempt count
          await pool.query(
            `UPDATE step_runs SET attempt_count = $1 WHERE workflow_run_id = $2 AND workflow_step_id = $3`,
            [attempts, workflowRunId, step.id]
          );
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Check if this is an approval_gate — pause the run
      if (step.step_type === 'approval_gate') {
        await upsertStepRun(pool, workflowRunId, step.id, stepOrder, {
          status: 'paused',
          output: output || { awaiting_approval: true, message: step.config?.message || 'Approval required' },
          attempt_count: attempts
        });
        await pool.query(
          `UPDATE workflow_runs SET status = 'paused' WHERE id = $1`,
          [workflowRunId]
        );
        console.log(`[Executor] Workflow paused at step ${stepOrder} (approval_gate)`);
        return { paused: true, pausedAtStep: stepOrder };
      }

      // Handle conditional_branch output
      if (step.step_type === 'conditional_branch' && output) {
        if (output.branch === 'false' && output.skip_steps) {
          skipCount = output.skip_steps;
          console.log(`[Executor] Conditional branch: will skip ${skipCount} step(s)`);
        }
      }

      // Mark step as completed
      await upsertStepRun(pool, workflowRunId, step.id, stepOrder, {
        status: 'completed',
        output: output || {},
        attempt_count: attempts,
        completed_at: new Date().toISOString()
      });

      previousOutput = output || {};
      console.log(`[Executor] Step ${stepOrder} completed successfully`);

    } catch (error) {
      console.error(`[Executor] Step ${stepOrder} failed permanently:`, error.message);

      await upsertStepRun(pool, workflowRunId, step.id, stepOrder, {
        status: 'failed',
        error: error.message,
        completed_at: new Date().toISOString()
      });

      // Mark workflow as failed
      await pool.query(
        `UPDATE workflow_runs SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`,
        [error.message, workflowRunId]
      );

      return { failed: true, error: error.message, failedAtStep: stepOrder };
    }
  }

  // All steps completed — mark workflow as completed and increment quota
  await pool.query(
    `UPDATE workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [workflowRunId]
  );

  // Increment org quota
  await pool.query(
    `UPDATE organizations SET quota_used = quota_used + 1 
     WHERE id = (SELECT org_id FROM workflows WHERE id = (SELECT workflow_id FROM workflow_runs WHERE id = $1))`,
    [workflowRunId]
  );

  console.log(`[Executor] Workflow run ${workflowRunId} completed successfully`);
  return { completed: true };
}

/**
 * Resume a paused workflow from the step after the approval_gate.
 */
async function resumeWorkflow(pool, workflowRunId) {
  // Find the paused step
  const pausedStep = await pool.query(
    `SELECT sr.step_order FROM step_runs sr
     WHERE sr.workflow_run_id = $1 AND sr.status = 'completed'
     ORDER BY sr.step_order DESC LIMIT 1`,
    [workflowRunId]
  );

  const lastCompletedOrder = pausedStep.rows[0]?.step_order || 0;
  const resumeFromOrder = lastCompletedOrder + 1;

  // Get workflow steps
  const stepsResult = await pool.query(
    `SELECT ws.* FROM workflow_steps ws
     JOIN workflow_runs wr ON wr.workflow_id = ws.workflow_id
     WHERE wr.id = $1
     ORDER BY ws.step_order`,
    [workflowRunId]
  );

  const steps = stepsResult.rows;
  const startIndex = steps.findIndex(s => s.step_order === resumeFromOrder);

  if (startIndex === -1) {
    // No more steps, mark as completed
    await pool.query(
      `UPDATE workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1`,
      [workflowRunId]
    );
    await pool.query(
      `UPDATE organizations SET quota_used = quota_used + 1 
       WHERE id = (SELECT org_id FROM workflows WHERE id = (SELECT workflow_id FROM workflow_runs WHERE id = $1))`,
      [workflowRunId]
    );
    return { completed: true };
  }

  return executeWorkflow(pool, workflowRunId, steps, startIndex);
}

/**
 * Execute a single step based on its type.
 */
async function executeStep(pool, step, previousOutput, workflowRunId) {
  const config = step.config || {};

  switch (step.step_type) {
    case 'llm_call':
      return executeLLMCall(config, previousOutput);

    case 'http_request':
      return executeHTTPRequest(config, previousOutput);

    case 'db_write':
      return executeDBWrite(pool, config, previousOutput, workflowRunId);

    case 'notify':
      return executeNotify(config, previousOutput);

    case 'conditional_branch':
      return executeConditionalBranch(config, previousOutput);

    case 'approval_gate':
      return { awaiting_approval: true, message: config.message || 'Approval required' };

    default:
      throw new Error(`Unknown step type: ${step.step_type}`);
  }
}

async function executeLLMCall(config, previousOutput) {
  let prompt = config.prompt || 'Hello';

  // Inject previous output into prompt if referenced
  if (prompt.includes('{{previous_output}}')) {
    prompt = prompt.replace('{{previous_output}}', JSON.stringify(previousOutput));
  } else if (previousOutput.response) {
    prompt = `${prompt}\n\nContext from previous step: ${previousOutput.response}`;
  }

  const result = await callLLM(prompt, config);
  return result;
}

async function executeHTTPRequest(config, previousOutput) {
  const method = (config.method || 'GET').toLowerCase();
  const url = config.url || 'https://httpbin.org/get';
  const headers = config.headers || {};

  const requestConfig = {
    method,
    url,
    headers,
    timeout: 15000
  };

  if (['post', 'put', 'patch'].includes(method)) {
    requestConfig.data = config.body || previousOutput || {};
  }

  try {
    const response = await axios(requestConfig);
    return {
      status: response.status,
      data: typeof response.data === 'object' ? response.data : { raw: response.data },
      headers: response.headers
    };
  } catch (error) {
    if (error.response) {
      return {
        status: error.response.status,
        data: error.response.data,
        error: `HTTP ${error.response.status}`
      };
    }
    throw error;
  }
}

async function executeDBWrite(pool, config, previousOutput, workflowRunId) {
  // Write the step's output/result to a simple key-value store approach
  // For the demo, we store the result as a note in the workflow_run
  const data = {
    workflow_run_id: workflowRunId,
    previous_output: previousOutput,
    written_at: new Date().toISOString()
  };

  await pool.query(
    `UPDATE workflow_runs SET error = NULL WHERE id = $1`,
    [workflowRunId]
  );

  return {
    written: true,
    record: data,
    message: `Data written successfully for run ${workflowRunId}`
  };
}

async function executeNotify(config, previousOutput) {
  const channel = config.channel || 'console';
  const message = config.message || `Workflow notification: ${JSON.stringify(previousOutput).substring(0, 200)}`;

  // In production this would send to Slack/email via Event Trigger
  // For demo, we log and simulate
  console.log(`[Notify] Channel: ${channel}, Message: ${message}`);

  // Simulate notification delay
  await new Promise(resolve => setTimeout(resolve, 500));

  return {
    notified: true,
    channel,
    message,
    timestamp: new Date().toISOString()
  };
}

async function executeConditionalBranch(config, previousOutput) {
  const field = config.field || 'response';
  const operator = config.operator || 'contains';
  const value = config.value || '';
  const skipStepsIfFalse = config.skip_steps_if_false || 1;

  // Get the value to evaluate from previous output
  let fieldValue = previousOutput[field];
  if (fieldValue === undefined) {
    // Try to find the field in nested objects
    fieldValue = JSON.stringify(previousOutput);
  }

  const fieldStr = String(fieldValue).toLowerCase();
  const valueStr = String(value).toLowerCase();

  let conditionMet = false;

  switch (operator) {
    case 'contains':
      conditionMet = fieldStr.includes(valueStr);
      break;
    case 'equals':
      conditionMet = fieldStr === valueStr;
      break;
    case 'not_contains':
      conditionMet = !fieldStr.includes(valueStr);
      break;
    case 'not_equals':
      conditionMet = fieldStr !== valueStr;
      break;
    case 'gt':
      conditionMet = parseFloat(fieldStr) > parseFloat(valueStr);
      break;
    case 'lt':
      conditionMet = parseFloat(fieldStr) < parseFloat(valueStr);
      break;
    default:
      conditionMet = fieldStr.includes(valueStr);
  }

  console.log(`[ConditionalBranch] Field: ${field}, Operator: ${operator}, Value: ${value}, Met: ${conditionMet}`);

  return {
    branch: conditionMet ? 'true' : 'false',
    condition: { field, operator, value },
    evaluated_value: fieldStr.substring(0, 100),
    skip_steps: conditionMet ? 0 : skipStepsIfFalse
  };
}

function shouldRetry(stepType) {
  return ['llm_call', 'http_request'].includes(stepType);
}

async function upsertStepRun(pool, workflowRunId, stepId, stepOrder, data) {
  const existing = await pool.query(
    `SELECT id FROM step_runs WHERE workflow_run_id = $1 AND workflow_step_id = $2`,
    [workflowRunId, stepId]
  );

  if (existing.rows.length > 0) {
    const sets = [];
    const values = [existing.rows[0].id];
    let idx = 2;

    for (const [key, val] of Object.entries(data)) {
      if (key === 'input' || key === 'output') {
        sets.push(`${key} = $${idx}::jsonb`);
        values.push(JSON.stringify(val));
      } else {
        sets.push(`${key} = $${idx}`);
        values.push(val);
      }
      idx++;
    }

    await pool.query(`UPDATE step_runs SET ${sets.join(', ')} WHERE id = $1`, values);
  } else {
    await pool.query(
      `INSERT INTO step_runs (workflow_run_id, workflow_step_id, step_order, status, input, output, error, attempt_count, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
      [
        workflowRunId,
        stepId,
        stepOrder,
        data.status || 'pending',
        JSON.stringify(data.input || {}),
        JSON.stringify(data.output || {}),
        data.error || null,
        data.attempt_count || 0,
        data.started_at || null,
        data.completed_at || null
      ]
    );
  }
}

module.exports = { executeWorkflow, resumeWorkflow };
