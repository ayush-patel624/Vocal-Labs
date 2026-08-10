'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';

const STEP_TYPE_ICONS = {
  llm_call: '🤖', http_request: '🌐', db_write: '💾',
  notify: '🔔', conditional_branch: '🔀', approval_gate: '✋'
};

const TRIGGER_TYPE_ICONS = {
  manual: '👆', webhook: '🔗', scheduled: '⏰', database_event: '🗄️'
};

export default function DashboardPage() {
  const { user, currentOrg, currentRole, organizations, switchOrg, logout, apiFetch, loading: authLoading } = useAuth();
  const router = useRouter();
  const [workflows, setWorkflows] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newWorkflow, setNewWorkflow] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [user, authLoading, router]);

  const fetchData = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const [wfData, usageData] = await Promise.all([
        apiFetch(`/api/workflows?org_id=${currentOrg.org_id}`),
        apiFetch(`/api/org/${currentOrg.org_id}/usage`)
      ]);
      setWorkflows(wfData.workflows || []);
      setUsage(usageData);
    } catch (e) {
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [currentOrg, apiFetch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const createWorkflow = async () => {
    if (!newWorkflow.name.trim()) return;
    setCreating(true);
    try {
      const data = await apiFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          org_id: currentOrg.org_id,
          name: newWorkflow.name,
          description: newWorkflow.description,
          steps: [],
          triggers: [{ trigger_type: 'manual', config: {} }]
        })
      });
      setShowNewModal(false);
      setNewWorkflow({ name: '', description: '' });
      router.push(`/workflows/${data.workflow_id}`);
    } catch (e) {
      alert(e.message);
    } finally {
      setCreating(false);
    }
  };

  if (authLoading || !user) {
    return <div className="loading-state" style={{ minHeight: '100vh' }}><div className="spinner"></div></div>;
  }

  const quotaPercent = usage ? Math.min((usage.quota_used / usage.quota_limit) * 100, 100) : 0;
  const quotaClass = quotaPercent > 90 ? 'danger' : quotaPercent > 70 ? 'warning' : '';

  return (
    <>
      {/* Navbar */}
      <nav className="navbar">
        <a className="navbar-brand" href="/dashboard">
          <div className="icon">⚡</div>
          <span>FlowForge</span>
        </a>
        <div className="navbar-actions">
          <div className="org-switcher">
            <span>🏢</span>
            <select value={currentOrg?.org_id || ''} onChange={e => switchOrg(e.target.value)}>
              {organizations.map(org => (
                <option key={org.org_id} value={org.org_id}>
                  {org.org_name} ({org.role})
                </option>
              ))}
            </select>
          </div>
          <div className="user-menu">
            <div className="user-avatar">{user.name?.[0] || '?'}</div>
            <span>{user.name}</span>
            <span className={`role-badge ${currentRole}`}>{currentRole}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
        </div>
      </nav>

      <div className="page-content">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.8rem' }}>Dashboard</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
              {currentOrg?.org_name} — {currentRole} access
            </p>
          </div>
          {currentRole !== 'viewer' && (
            <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>
              + New Workflow
            </button>
          )}
        </div>

        <div className="dashboard-grid">
          {/* Quota Card */}
          <div className="card stat-card">
            <div className="card-header">
              <span className="card-title">📊 Usage Quota</span>
            </div>
            <div className="stat-value">{usage?.quota_used || 0} / {usage?.quota_limit || 0}</div>
            <div className="stat-label">Runs this period</div>
            <div className="quota-bar">
              <div className={`quota-bar-fill ${quotaClass}`} style={{ width: `${quotaPercent}%` }}></div>
            </div>
            <div className="quota-info">
              <span>{quotaPercent.toFixed(0)}% used</span>
              <span>{(usage?.quota_limit || 0) - (usage?.quota_used || 0)} remaining</span>
            </div>
          </div>

          {/* Stats Card */}
          <div className="card stat-card">
            <div className="card-header">
              <span className="card-title">📈 This Month</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem' }}>
              <div>
                <div className="stat-value" style={{ fontSize: '1.5rem' }}>{usage?.total_runs_this_month || 0}</div>
                <div className="stat-label">Total Runs</div>
              </div>
              <div>
                <div className="stat-value" style={{ fontSize: '1.5rem' }}>
                  {usage?.avg_run_duration_seconds ? `${parseFloat(usage.avg_run_duration_seconds).toFixed(1)}s` : '—'}
                </div>
                <div className="stat-label">Avg Duration</div>
              </div>
              <div>
                <div className="stat-value" style={{ fontSize: '1.5rem' }}>{usage?.completed_runs || 0}</div>
                <div className="stat-label">Completed</div>
              </div>
              <div>
                <div className="stat-value" style={{ fontSize: '1.5rem', background: 'var(--gradient-danger)', WebkitBackgroundClip: 'text' }}>{usage?.failed_runs || 0}</div>
                <div className="stat-label">Failed</div>
              </div>
            </div>
          </div>

          {/* Workflows List */}
          <div className="card full-width">
            <div className="card-header">
              <span className="card-title">⚡ Workflows</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{workflows.length} workflows</span>
            </div>
            {loading ? (
              <div className="loading-state"><div className="spinner"></div> Loading workflows...</div>
            ) : workflows.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🔧</div>
                <p>No workflows yet. Create your first workflow to get started!</p>
              </div>
            ) : (
              <div className="workflow-list">
                {workflows.map(wf => {
                  const stepCount = wf.steps ? (Array.isArray(wf.steps) ? wf.steps.length : 0) : 0;
                  const lastRun = wf.recent_runs?.[0];
                  return (
                    <a key={wf.id} className="workflow-list-item" href={`/workflows/${wf.id}`}>
                      <div className="workflow-icon">⚡</div>
                      <div className="workflow-info">
                        <div className="workflow-name">{wf.name}</div>
                        <div className="workflow-meta">
                          {stepCount} steps • {wf.description || 'No description'}
                        </div>
                      </div>
                      {lastRun && (
                        <span className={`status-badge ${lastRun.status}`}>
                          <span className="status-dot"></span>
                          {lastRun.status}
                        </span>
                      )}
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* New Workflow Modal */}
      {showNewModal && (
        <div className="modal-overlay" onClick={() => setShowNewModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Create New Workflow</h3>
              <button className="modal-close" onClick={() => setShowNewModal(false)}>✕</button>
            </div>
            <div className="form-group">
              <label className="form-label">Workflow Name</label>
              <input
                className="form-input"
                placeholder="e.g., AI Content Pipeline"
                value={newWorkflow.name}
                onChange={e => setNewWorkflow(prev => ({ ...prev, name: e.target.value }))}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-textarea"
                placeholder="What does this workflow do?"
                value={newWorkflow.description}
                onChange={e => setNewWorkflow(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowNewModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={createWorkflow} disabled={creating || !newWorkflow.name.trim()}>
                {creating ? 'Creating...' : 'Create Workflow'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
