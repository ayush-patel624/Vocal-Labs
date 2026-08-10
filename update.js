const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:postgres@postgres:5432/workflow_builder' });
async function run() {
  await pool.query("UPDATE workflow_triggers SET config = '{\"time\": \"14:16\"}' WHERE trigger_type = 'scheduled'");
  console.log("Updated");
  process.exit();
}
run();
