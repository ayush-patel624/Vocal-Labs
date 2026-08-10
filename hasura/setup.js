/**
 * Hasura Metadata Setup Script
 * Applies table tracking, relationships, permissions, and action definitions
 * via the Hasura Metadata API (v1/metadata).
 * 
 * Usage: node setup.js
 */

const axios = require('axios');

const HASURA_URL = process.env.HASURA_URL || 'http://localhost:8085';
const ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET || 'myadminsecret';
const ACTION_HANDLER_URL = process.env.ACTION_HANDLER_URL || 'http://action-handler:3001';

const api = axios.create({
  baseURL: HASURA_URL,
  headers: {
    'Content-Type': 'application/json',
    'X-Hasura-Admin-Secret': ADMIN_SECRET
  }
});

async function waitForHasura() {
  console.log('Waiting for Hasura...');
  for (let i = 0; i < 30; i++) {
    try {
      await api.get('/healthz');
      console.log('Hasura is ready!');
      return;
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Hasura not ready after 60 seconds');
}

async function applyMetadata() {
  const metadata = {
    version: 3,
    sources: [
      {
        name: 'default',
        kind: 'postgres',
        tables: getTables(),
        configuration: {
          connection_info: {
            database_url: { from_env: 'HASURA_GRAPHQL_DATABASE_URL' },
            pool_settings: {
              max_connections: 50,
              idle_timeout: 180
            }
          }
        }
      }
    ],
    actions: getActions(),
    custom_types: getCustomTypes()
  };

  console.log('Applying metadata...');
  const res = await api.post('/v1/metadata', {
    type: 'replace_metadata',
    version: 2,
    args: {
      allow_inconsistent_metadata: true,
      metadata
    }
  });

  console.log('Metadata applied:', res.data);
}

function getTables() {
  return [
    // ---- users ----
    {
      table: { schema: 'public', name: 'users' },
      array_relationships: [
        {
          name: 'org_memberships',
          using: { foreign_key_constraint_on: { column: 'user_id', table: { schema: 'public', name: 'org_members' } } }
        }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'email', 'name', 'created_at'],
            filter: {
              org_memberships: {
                org: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' }
                  }
                }
              }
            }
          }
        }
      ]
    },

    // ---- organizations ----
    {
      table: { schema: 'public', name: 'organizations' },
      array_relationships: [
        {
          name: 'org_members',
          using: { foreign_key_constraint_on: { column: 'org_id', table: { schema: 'public', name: 'org_members' } } }
        },
        {
          name: 'workflows',
          using: { foreign_key_constraint_on: { column: 'org_id', table: { schema: 'public', name: 'workflows' } } }
        }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'name', 'quota_limit', 'quota_used', 'quota_period_start', 'created_at'],
            filter: {
              org_members: {
                user_id: { _eq: 'X-Hasura-User-Id' }
              }
            }
          }
        }
      ]
    },

    // ---- org_members ----
    {
      table: { schema: 'public', name: 'org_members' },
      object_relationships: [
        { name: 'user', using: { foreign_key_constraint_on: 'user_id' } },
        { name: 'org', using: { foreign_key_constraint_on: 'org_id' } }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'user_id', 'org_id', 'role', 'created_at'],
            filter: {
              org: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' }
                }
              }
            }
          }
        }
      ],
      insert_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['user_id', 'org_id', 'role'],
            check: {
              org: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' },
                  role: { _eq: 'owner' }
                }
              }
            }
          }
        }
      ],
      update_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['role'],
            filter: {
              org: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' },
                  role: { _eq: 'owner' }
                }
              }
            }
          }
        }
      ],
      delete_permissions: [
        {
          role: 'user',
          permission: {
            filter: {
              org: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' },
                  role: { _eq: 'owner' }
                }
              }
            }
          }
        }
      ]
    },

    // ---- workflows ----
    {
      table: { schema: 'public', name: 'workflows' },
      object_relationships: [
        { name: 'organization', using: { foreign_key_constraint_on: 'org_id' } },
        { name: 'creator', using: { foreign_key_constraint_on: 'created_by' } }
      ],
      array_relationships: [
        {
          name: 'steps',
          using: { foreign_key_constraint_on: { column: 'workflow_id', table: { schema: 'public', name: 'workflow_steps' } } }
        },
        {
          name: 'triggers',
          using: { foreign_key_constraint_on: { column: 'workflow_id', table: { schema: 'public', name: 'workflow_triggers' } } }
        },
        {
          name: 'runs',
          using: { foreign_key_constraint_on: { column: 'workflow_id', table: { schema: 'public', name: 'workflow_runs' } } }
        }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'org_id', 'name', 'description', 'created_by', 'is_active', 'created_at', 'updated_at'],
            filter: {
              organization: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' }
                }
              }
            },
            allow_aggregations: true
          }
        }
      ],
      insert_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['org_id', 'name', 'description', 'created_by'],
            check: {
              organization: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' },
                  role: { _in: ['owner', 'editor'] }
                }
              }
            }
          }
        }
      ],
      update_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['name', 'description', 'is_active'],
            filter: {
              organization: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' },
                  role: { _in: ['owner', 'editor'] }
                }
              }
            }
          }
        }
      ],
      delete_permissions: [
        {
          role: 'user',
          permission: {
            filter: {
              organization: {
                org_members: {
                  user_id: { _eq: 'X-Hasura-User-Id' },
                  role: { _eq: 'owner' }
                }
              }
            }
          }
        }
      ]
    },

    // ---- workflow_steps ----
    {
      table: { schema: 'public', name: 'workflow_steps' },
      object_relationships: [
        { name: 'workflow', using: { foreign_key_constraint_on: 'workflow_id' } }
      ],
      array_relationships: [
        {
          name: 'step_runs',
          using: { foreign_key_constraint_on: { column: 'workflow_step_id', table: { schema: 'public', name: 'step_runs' } } }
        }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'workflow_id', 'step_order', 'step_type', 'name', 'config', 'created_at'],
            filter: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' }
                  }
                }
              }
            }
          }
        }
      ],
      insert_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['workflow_id', 'step_order', 'step_type', 'name', 'config'],
            check: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' },
                    role: { _in: ['owner', 'editor'] }
                  }
                }
              }
            }
          }
        }
      ],
      update_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['step_order', 'step_type', 'name', 'config'],
            filter: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' },
                    role: { _in: ['owner', 'editor'] }
                  }
                }
              }
            }
          }
        }
      ],
      delete_permissions: [
        {
          role: 'user',
          permission: {
            filter: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' },
                    role: { _in: ['owner', 'editor'] }
                  }
                }
              }
            }
          }
        }
      ]
    },

    // ---- workflow_triggers ----
    {
      table: { schema: 'public', name: 'workflow_triggers' },
      object_relationships: [
        { name: 'workflow', using: { foreign_key_constraint_on: 'workflow_id' } }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'workflow_id', 'trigger_type', 'config', 'is_active', 'created_at'],
            filter: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' }
                  }
                }
              }
            }
          }
        }
      ],
      insert_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['workflow_id', 'trigger_type', 'config'],
            check: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' },
                    role: { _in: ['owner', 'editor'] }
                  }
                }
              }
            }
          }
        }
      ],
      delete_permissions: [
        {
          role: 'user',
          permission: {
            filter: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' },
                    role: { _in: ['owner', 'editor'] }
                  }
                }
              }
            }
          }
        }
      ]
    },

    // ---- workflow_runs ----
    {
      table: { schema: 'public', name: 'workflow_runs' },
      object_relationships: [
        { name: 'workflow', using: { foreign_key_constraint_on: 'workflow_id' } },
        { name: 'triggered_by_user', using: { foreign_key_constraint_on: 'triggered_by' } }
      ],
      array_relationships: [
        {
          name: 'step_runs',
          using: { foreign_key_constraint_on: { column: 'workflow_run_id', table: { schema: 'public', name: 'step_runs' } } }
        }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['id', 'workflow_id', 'status', 'triggered_by', 'trigger_type', 'error', 'started_at', 'completed_at'],
            filter: {
              workflow: {
                organization: {
                  org_members: {
                    user_id: { _eq: 'X-Hasura-User-Id' }
                  }
                }
              }
            },
            allow_aggregations: true
          }
        }
      ]
    },

    // ---- step_runs ----
    {
      table: { schema: 'public', name: 'step_runs' },
      object_relationships: [
        { name: 'workflow_run', using: { foreign_key_constraint_on: 'workflow_run_id' } },
        { name: 'workflow_step', using: { foreign_key_constraint_on: 'workflow_step_id' } },
        { name: 'approver', using: { foreign_key_constraint_on: 'approved_by' } }
      ],
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: [
              'id', 'workflow_run_id', 'workflow_step_id', 'step_order',
              'status', 'input', 'output', 'error', 'attempt_count',
              'approved_by', 'approved_at', 'started_at', 'completed_at'
            ],
            filter: {
              workflow_run: {
                workflow: {
                  organization: {
                    org_members: {
                      user_id: { _eq: 'X-Hasura-User-Id' }
                    }
                  }
                }
              }
            },
            allow_aggregations: true
          }
        }
      ]
    },

    // ---- org_monthly_usage (view) ----
    {
      table: { schema: 'public', name: 'org_monthly_usage' },
      select_permissions: [
        {
          role: 'user',
          permission: {
            columns: ['org_id', 'org_name', 'quota_limit', 'quota_used', 'total_runs_this_month', 'avg_run_duration_seconds', 'completed_runs', 'failed_runs'],
            filter: {
              org_id: {
                _in: 'X-Hasura-Allowed-Org-Ids'
              }
            }
          }
        }
      ]
    }
  ];
}

function getActions() {
  return [
    {
      name: 'triggerWorkflowRun',
      definition: {
        kind: 'synchronous',
        handler: `${ACTION_HANDLER_URL}/trigger-workflow-run`,
        forward_client_headers: true,
        output_type: 'TriggerWorkflowRunOutput'
      },
      permissions: [{ role: 'user' }]
    },
    {
      name: 'approveStep',
      definition: {
        kind: 'synchronous',
        handler: `${ACTION_HANDLER_URL}/approve-step`,
        forward_client_headers: true,
        output_type: 'ApproveStepOutput'
      },
      permissions: [{ role: 'user' }]
    }
  ];
}

function getCustomTypes() {
  return {
    input_objects: [
      {
        name: 'TriggerWorkflowRunInput',
        fields: [
          { name: 'workflow_id', type: 'uuid!' }
        ]
      },
      {
        name: 'ApproveStepInput',
        fields: [
          { name: 'step_run_id', type: 'uuid!' }
        ]
      }
    ],
    objects: [
      {
        name: 'TriggerWorkflowRunOutput',
        fields: [
          { name: 'workflow_run_id', type: 'String!' },
          { name: 'status', type: 'String!' }
        ]
      },
      {
        name: 'ApproveStepOutput',
        fields: [
          { name: 'success', type: 'Boolean!' },
          { name: 'message', type: 'String!' }
        ]
      }
    ]
  };
}

async function main() {
  try {
    await waitForHasura();
    await applyMetadata();
    console.log('Setup complete!');
  } catch (error) {
    console.error('Setup failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

main();
