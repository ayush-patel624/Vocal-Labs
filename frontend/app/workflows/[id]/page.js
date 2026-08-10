'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { useRouter, useParams } from 'next/navigation';

const STEP_TYPES = [
  { type: 'llm_call', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>, label: 'LLM Call', desc: 'Call an AI model', restrictedTo: null },
  { type: 'http_request', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>, label: 'HTTP Request', desc: 'Call external API', restrictedTo: null },
  { type: 'conditional_branch', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>, label: 'Conditional', desc: 'If/else logic', restrictedTo: null },
  { type: 'approval_gate', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>, label: 'Approval Gate', desc: 'Pause for approval', restrictedTo: null },
  { type: 'db_write', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>, label: 'DB Write', desc: 'Save to database', restrictedTo: 'owner' },
  { type: 'notify', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>, label: 'Notify', desc: 'Send notification', restrictedTo: 'owner' },
];

const TRIGGER_TYPES = [
  { type: 'manual', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /></svg>, label: 'Manual', restrictedTo: null },
  { type: 'webhook', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>, label: 'Webhook', restrictedTo: 'owner' },
  { type: 'scheduled', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>, label: 'Scheduled', restrictedTo: 'owner' },
  { type: 'database_event', icon: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>, label: 'DB Event', restrictedTo: 'owner' },
];

const DEFAULT_CONFIGS = {
  llm_call: { prompt: 'Analyze the following data and provide insights.', model: 'default' },
  http_request: { url: 'https://jsonplaceholder.typicode.com/posts/1', method: 'GET', headers: { 'Content-Type': 'application/json' } },
  db_write: { table: 'workflow_runs', fields: ['output'] },
  notify: { channel: 'console', message: 'Workflow step completed' },
  conditional_branch: { field: 'response', operator: 'contains', value: 'positive', skip_steps_if_false: 1 },
  approval_gate: { required_role: 'owner', message: 'Please review and approve to continue.' },
};

export default function WorkflowPage() {
  const params = useParams();
  const workflowId = params.id;
  const router = useRouter();
  const { user, currentOrg, currentRole, organizations, switchOrg, logout, apiFetch, loading: authLoading } = useAuth();

  const [workflow, setWorkflow] = useState(null);
  const [role, setRole] = useState(null);
  const [steps, setSteps] = useState([]);
  const [triggers, setTriggers] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('builder');
  const [showAddStep, setShowAddStep] = useState(false);
  const [showAddTrigger, setShowAddTrigger] = useState(false);
  const [editingStep, setEditingStep] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [stepRuns, setStepRuns] = useState([]);
  const [runPolling, setRunPolling] = useState(false);
  const pollRef = useRef(null);
  const [toasts, setToasts] = useState([]);

  const addToast = (msg, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [user, authLoading, router]);

  const fetchWorkflow = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/workflows/${workflowId}`);
      setWorkflow(data.workflow);
      setRole(data.role);
      setSteps(data.workflow.steps || []);
      setTriggers(data.workflow.triggers || []);
      setRuns(data.workflow.recent_runs || []);
    } catch (e) {
      if (e.message.includes('403') || e.message.includes('Access denied')) {
        addToast('Access denied: You are not a member of this organization', 'error');
        setTimeout(() => router.push('/dashboard'), 2000);
      }
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [workflowId, apiFetch, router]);

  useEffect(() => { if (user) fetchWorkflow(); }, [user, fetchWorkflow]);

  // Polling for active run
  useEffect(() => {
    if (activeRun && runPolling) {
      const poll = async () => {
        try {
          const data = await apiFetch(`/api/runs/${activeRun}`);
          setStepRuns(data.step_runs || []);
          if (['completed', 'failed'].includes(data.run?.status)) {
            setRunPolling(false);
            addToast(`Workflow run ${data.run.status}!`, data.run.status === 'completed' ? 'success' : 'error');
            fetchWorkflow();
          }
          if (data.run?.status === 'paused') {
            addToast('Workflow paused — awaiting approval', 'info');
          }
        } catch (e) {
          console.error('Poll error:', e);
        }
      };
      poll();
      pollRef.current = setInterval(poll, 1500);
      return () => clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeRun, runPolling, apiFetch, fetchWorkflow]);

  const saveWorkflow = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/workflows/${workflowId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: workflow.name,
          description: workflow.description,
          steps: steps.map((s, i) => ({
            id: s.id && !s.id.startsWith('temp') ? s.id : undefined,
            step_order: i + 1,
            step_type: s.step_type,
            name: s.name,
            config: s.config
          })),
          triggers: triggers.map(t => ({
            id: t.id && !t.id.startsWith('temp') ? t.id : undefined,
            trigger_type: t.trigger_type,
            config: t.config || {}
          }))
        })
      });
      addToast('Workflow saved successfully!', 'success');
      await fetchWorkflow();
      return true;
    } catch (e) {
      addToast(e.message, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const triggerRun = async () => {
    try {
      const saved = await saveWorkflow();
      if (!saved) return;

      const data = await apiFetch('/api/trigger-run', {
        method: 'POST',
        body: JSON.stringify({ workflow_id: workflowId })
      });
      addToast('Workflow started!', 'success');
      setActiveRun(data.workflow_run_id);
      setStepRuns([]);
      setRunPolling(true);
      setActiveTab('runs');
    } catch (e) {
      addToast(e.message, 'error');
    }
  };

  const approveStep = async (stepRunId) => {
    try {
      await apiFetch('/api/approve-step', {
        method: 'POST',
        body: JSON.stringify({ step_run_id: stepRunId })
      });
      addToast('Step approved! Workflow resuming...', 'success');
      setRunPolling(true);
    } catch (e) {
      addToast(e.message, 'error');
    }
  };

  const rejectStep = async (stepRunId) => {
    try {
      await apiFetch('/api/reject-step', {
        method: 'POST',
        body: JSON.stringify({ step_run_id: stepRunId })
      });
      addToast('Step rejected! Workflow stopped.', 'success');
      setRunPolling(true);
    } catch (e) {
      addToast(e.message, 'error');
    }
  };

  const viewRun = async (runId) => {
    setActiveRun(runId);
    try {
      const data = await apiFetch(`/api/runs/${runId}`);
      setStepRuns(data.step_runs || []);
      setActiveTab('runs');
      if (['running', 'paused', 'pending'].includes(data.run?.status)) {
        setRunPolling(true);
      }
    } catch (e) {
      addToast(e.message, 'error');
    }
  };

  const addStep = (stepType) => {
    const newStep = {
      id: `temp-${Date.now()}`,
      step_order: steps.length + 1,
      step_type: stepType.type,
      name: stepType.label,
      config: { ...DEFAULT_CONFIGS[stepType.type] }
    };
    setSteps(prev => [...prev, newStep]);
    setShowAddStep(false);
    setEditingStep(steps.length);
  };

  const removeStep = (index) => {
    setSteps(prev => prev.filter((_, i) => i !== index));
    if (editingStep === index) setEditingStep(null);
  };

  const moveStep = (index, direction) => {
    const newSteps = [...steps];
    const target = index + direction;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    setSteps(newSteps);
    if (editingStep === index) setEditingStep(target);
  };

  const updateStepConfig = (index, field, value) => {
    setSteps(prev => prev.map((s, i) => i === index ? {
      ...s,
      config: { ...s.config, [field]: value }
    } : s));
  };

  const updateStepName = (index, name) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, name } : s));
  };

  const addTrigger = (triggerType) => {
    const config = triggerType.type === 'webhook'
      ? { secret: `whsec_${Math.random().toString(36).slice(2, 10)}` }
      : {};
    setTriggers(prev => [...prev, {
      id: `temp-${Date.now()}`,
      trigger_type: triggerType.type,
      config,
      is_active: true
    }]);
    setShowAddTrigger(false);
  };

  const updateTriggerConfig = (index, field, value) => {
    setTriggers(prev => prev.map((t, i) => i === index ? {
      ...t,
      config: { ...t.config, [field]: value }
    } : t));
  };

  const removeTrigger = (index) => {
    setTriggers(prev => prev.filter((_, i) => i !== index));
  };

  if (authLoading || !user || loading) {
    return <div className="loading-state" style={{ minHeight: '100vh' }}><div className="spinner"></div></div>;
  }

  if (!workflow) {
    return <div className="loading-state" style={{ minHeight: '100vh' }}>Workflow not found</div>;
  }

  const canEdit = role === 'owner' || role === 'editor';
  const canTrigger = role === 'owner' || role === 'editor';

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
                <option key={org.org_id} value={org.org_id}>{org.org_name} ({org.role})</option>
              ))}
            </select>
          </div>
          <div className="user-menu">
            <div className="user-avatar">{user.name?.[0]}</div>
            <span>{user.name}</span>
            <span className={`role-badge ${currentRole}`}>{currentRole}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
        </div>
      </nav>

      <div className="page-content">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <a href="/dashboard" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '0.85rem' }}>← Workflows</a>
            </div>
            {canEdit ? (
              <input
                className="form-input"
                value={workflow.name}
                onChange={e => setWorkflow(prev => ({ ...prev, name: e.target.value }))}
                style={{ fontSize: '1.5rem', fontWeight: 700, background: 'transparent', border: 'none', padding: 0, marginTop: '0.5rem', width: '100%' }}
              />
            ) : (
              <h1 style={{ fontSize: '1.5rem', marginTop: '0.5rem' }}>{workflow.name}</h1>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              {workflow.org_name} • {role} access
              {workflow.quota_used !== undefined && ` • Quota: ${workflow.quota_used}/${workflow.quota_limit}`}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {canEdit && (
              <button className="btn btn-ghost" onClick={saveWorkflow} disabled={saving}>
                {saving ? '💾 Saving...' : '💾 Save'}
              </button>
            )}
            {canTrigger && (
              <button className="btn btn-success" onClick={triggerRun}>
                ▶ Run Workflow
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="tab-bar">
          <button className={`tab ${activeTab === 'builder' ? 'active' : ''}`} onClick={() => setActiveTab('builder')}>
            🔧 Builder
          </button>
          <button className={`tab ${activeTab === 'runs' ? 'active' : ''}`} onClick={() => setActiveTab('runs')}>
            📊 Runs {activeRun && runPolling && <span className="spinner" style={{ width: 12, height: 12, marginLeft: 6 }}></span>}
          </button>
        </div>

        {/* Builder Tab */}
        {activeTab === 'builder' && (
          <div className="workflow-builder">
            <div className="steps-panel">
              <h3 style={{ marginBottom: '0.5rem' }}>Steps ({steps.length})</h3>
              {steps.length === 0 ? (
                <div className="empty-state">
                  <div style={{ padding: '2rem' }}>
                    <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.5, marginBottom: '1rem' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </div>
                  <p>Add steps to build your workflow pipeline</p>
                </div>
              ) : (
                steps.map((step, idx) => (
                  <div key={step.id || idx}>
                    {idx > 0 && <div className="step-connector"></div>}
                    <div className={`step-card ${editingStep === idx ? '' : ''}`} onClick={() => setEditingStep(editingStep === idx ? null : idx)}>
                      <div className="step-number">{idx + 1}</div>
                      <div className={`step-icon ${step.step_type}`}>
                        {STEP_TYPES.find(t => t.type === step.step_type)?.icon || '❓'}
                      </div>
                      <div className="step-content">
                        <div className="step-type-label">{step.step_type.replace('_', ' ')}</div>
                        <div className="step-name">{step.name}</div>
                        <div className="step-config-preview">
                          {step.step_type === 'llm_call' && (step.config?.prompt || '').substring(0, 60)}
                          {step.step_type === 'http_request' && `${step.config?.method || 'GET'} ${step.config?.url || ''}`}
                          {step.step_type === 'conditional_branch' && `If ${step.config?.field} ${step.config?.operator} "${step.config?.value}"`}
                          {step.step_type === 'approval_gate' && (step.config?.message || 'Awaiting approval')}
                          {step.step_type === 'db_write' && `Write to ${step.config?.table || 'table'}`}
                          {step.step_type === 'notify' && `Channel: ${step.config?.channel || 'console'}`}
                        </div>
                      </div>
                      {canEdit && (
                        <div className="step-actions">
                          <button className="btn btn-icon btn-ghost btn-sm" onClick={e => { e.stopPropagation(); moveStep(idx, -1); }} disabled={idx === 0}>↑</button>
                          <button className="btn btn-icon btn-ghost btn-sm" onClick={e => { e.stopPropagation(); moveStep(idx, 1); }} disabled={idx === steps.length - 1}>↓</button>
                          <button className="btn btn-icon btn-ghost btn-sm" onClick={e => { e.stopPropagation(); removeStep(idx); }} style={{ color: 'var(--accent-red)' }}>✕</button>
                        </div>
                      )}
                    </div>

                    {/* Step Config Editor */}
                    {editingStep === idx && (
                      <div className="card" style={{ marginTop: '0.5rem', marginLeft: '2.5rem', borderColor: 'var(--accent-blue)', borderLeftWidth: '3px' }}>
                        <h4 style={{ marginBottom: '0.75rem' }}>Configure: {step.name}</h4>
                        <div className="form-group">
                          <label className="form-label">Step Name</label>
                          <input className="form-input" value={step.name} onChange={e => updateStepName(idx, e.target.value)} disabled={!canEdit} />
                        </div>
                        {step.step_type === 'llm_call' && (
                          <div className="form-group">
                            <label className="form-label">Prompt</label>
                            <textarea className="form-textarea" value={step.config?.prompt || ''} onChange={e => updateStepConfig(idx, 'prompt', e.target.value)} disabled={!canEdit} rows={4} />
                          </div>
                        )}
                        {step.step_type === 'http_request' && (
                          <>
                            <div className="form-group">
                              <label className="form-label">URL</label>
                              <input className="form-input" value={step.config?.url || ''} onChange={e => updateStepConfig(idx, 'url', e.target.value)} disabled={!canEdit} />
                            </div>
                            <div className="form-group">
                              <label className="form-label">Method</label>
                              <select className="form-select" value={step.config?.method || 'GET'} onChange={e => updateStepConfig(idx, 'method', e.target.value)} disabled={!canEdit}>
                                <option value="GET">GET</option>
                                <option value="POST">POST</option>
                                <option value="PUT">PUT</option>
                                <option value="DELETE">DELETE</option>
                              </select>
                            </div>
                          </>
                        )}
                        {step.step_type === 'conditional_branch' && (
                          <>
                            <div className="form-group">
                              <label className="form-label">Field to Check</label>
                              <input className="form-input" value={step.config?.field || ''} onChange={e => updateStepConfig(idx, 'field', e.target.value)} disabled={!canEdit} placeholder="e.g., response" />
                            </div>
                            <div className="form-group">
                              <label className="form-label">Operator</label>
                              <select className="form-select" value={step.config?.operator || 'contains'} onChange={e => updateStepConfig(idx, 'operator', e.target.value)} disabled={!canEdit}>
                                <option value="contains">Contains</option>
                                <option value="not_contains">Not Contains</option>
                                <option value="equals">Equals</option>
                                <option value="not_equals">Not Equals</option>
                                <option value="gt">Greater Than</option>
                                <option value="lt">Less Than</option>
                              </select>
                            </div>
                            <div className="form-group">
                              <label className="form-label">Value</label>
                              <input className="form-input" value={step.config?.value || ''} onChange={e => updateStepConfig(idx, 'value', e.target.value)} disabled={!canEdit} placeholder="e.g., positive" />
                            </div>
                            <div className="form-group">
                              <label className="form-label">Steps to Skip if False</label>
                              <input className="form-input" type="number" min="0" value={step.config?.skip_steps_if_false || 1} onChange={e => updateStepConfig(idx, 'skip_steps_if_false', parseInt(e.target.value) || 1)} disabled={!canEdit} />
                            </div>
                          </>
                        )}
                        {step.step_type === 'approval_gate' && (
                          <div className="form-group">
                            <label className="form-label">Approval Message</label>
                            <textarea className="form-textarea" value={step.config?.message || ''} onChange={e => updateStepConfig(idx, 'message', e.target.value)} disabled={!canEdit} />
                          </div>
                        )}
                        {step.step_type === 'notify' && (
                          <>
                            <div className="form-group">
                              <label className="form-label">Channel</label>
                              <select className="form-select" value={step.config?.channel || 'console'} onChange={e => updateStepConfig(idx, 'channel', e.target.value)} disabled={!canEdit}>
                                <option value="console">Console</option>
                                <option value="slack">Slack</option>
                                <option value="email">Email</option>
                              </select>
                            </div>
                            <div className="form-group">
                              <label className="form-label">Message</label>
                              <input className="form-input" value={step.config?.message || ''} onChange={e => updateStepConfig(idx, 'message', e.target.value)} disabled={!canEdit} />
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}

              {canEdit && (
                <>
                  {steps.length > 0 && <div className="step-connector"></div>}
                  <button className="add-step-btn" onClick={() => setShowAddStep(!showAddStep)}>
                    {showAddStep ? '✕ Cancel' : '+ Add Step'}
                  </button>
                  {showAddStep && (
                    <div className="step-type-grid" style={{ marginTop: '0.5rem' }}>
                      {STEP_TYPES.map(st => (
                        <button
                          key={st.type}
                          className="step-type-option"
                          onClick={() => addStep(st)}
                          disabled={st.restrictedTo && role !== st.restrictedTo}
                          title={st.restrictedTo ? `Only ${st.restrictedTo}s can add this step` : ''}
                        >
                          <span>{st.icon}</span>
                          <div>
                            <div style={{ fontWeight: 600 }}>{st.label}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              {st.desc}
                              {st.restrictedTo && ` (${st.restrictedTo} only)`}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Side Panel: Triggers + Runs */}
            <div className="side-panel">
              {/* Triggers */}
              <div className="card">
                <div className="card-header">
                  <span className="card-title">🎯 Triggers</span>
                  {canEdit && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowAddTrigger(!showAddTrigger)}>
                      {showAddTrigger ? '✕' : '+'}
                    </button>
                  )}
                </div>
                {showAddTrigger && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.75rem' }}>
                    {TRIGGER_TYPES.map(tt => (
                      <button
                        key={tt.type}
                        className="step-type-option"
                        onClick={() => addTrigger(tt)}
                        disabled={(tt.restrictedTo && role !== tt.restrictedTo) || triggers.some(t => t.trigger_type === tt.type)}
                        style={{ padding: '0.5rem 0.7rem' }}
                      >
                        <span>{tt.icon}</span>
                        <span>{tt.label}</span>
                        {tt.restrictedTo && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>({tt.restrictedTo} only)</span>}
                      </button>
                    ))}
                  </div>
                )}
                <div className="trigger-list">
                  {triggers.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No triggers configured</p>
                  ) : triggers.map((trigger, idx) => (
                    <div key={trigger.id || idx} className="trigger-item">
                      <span className="trigger-icon">{TRIGGER_TYPES.find(t => t.type === trigger.trigger_type)?.icon || '❓'}</span>
                      <div className="trigger-info">
                        <div className="trigger-type">{trigger.trigger_type.replace('_', ' ')}</div>
                        {trigger.trigger_type === 'webhook' && (
                          <div className="trigger-detail" style={{ wordBreak: 'break-all' }}>
                            POST /webhook/{workflowId}
                          </div>
                        )}
                        {trigger.trigger_type === 'scheduled' && (
                          <div className="trigger-detail" style={{ marginTop: '0.5rem' }}>
                            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Time (IST)</label>
                            <input className="form-input" type="time" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }} value={trigger.config?.time || ''} onChange={e => updateTriggerConfig(idx, 'time', e.target.value)} disabled={!canEdit} />
                          </div>
                        )}
                        {trigger.trigger_type === 'database_event' && (
                          <div className="trigger-detail" style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexDirection: 'column' }}>
                            <input className="form-input" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} value={trigger.config?.table || ''} onChange={e => updateTriggerConfig(idx, 'table', e.target.value)} disabled={!canEdit} placeholder="Table name" />
                            <select className="form-select" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} value={trigger.config?.event || 'INSERT'} onChange={e => updateTriggerConfig(idx, 'event', e.target.value)} disabled={!canEdit}>
                              <option value="INSERT">INSERT</option>
                              <option value="UPDATE">UPDATE</option>
                              <option value="DELETE">DELETE</option>
                            </select>
                          </div>
                        )}
                      </div>
                      {canEdit && (
                        <button className="btn btn-icon btn-ghost btn-sm" onClick={() => removeTrigger(idx)} style={{ color: 'var(--accent-red)' }}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Runs */}
              <div className="card">
                <div className="card-header">
                  <span className="card-title">📋 Recent Runs</span>
                </div>
                {runs.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No runs yet</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {runs.slice(0, 5).map(run => (
                      <div
                        key={run.id}
                        onClick={() => viewRun(run.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.75rem',
                          padding: '0.5rem 0.6rem', background: 'var(--bg-glass)',
                          borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                          border: activeRun === run.id ? '1px solid var(--accent-blue)' : '1px solid transparent',
                          transition: 'var(--transition-fast)'
                        }}
                      >
                        <span className={`status-badge ${run.status}`}>
                          <span className="status-dot"></span>
                          {run.status}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flex: 1 }}>
                          {run.trigger_type} • {new Date(run.started_at).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Quota */}
              <div className="card">
                <div className="card-header">
                  <span className="card-title">📊 Quota</span>
                </div>
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>{workflow.quota_used || 0}</strong> / {workflow.quota_limit || 0} runs used
                </div>
                <div className="quota-bar">
                  <div
                    className={`quota-bar-fill ${(workflow.quota_used / workflow.quota_limit) > 0.9 ? 'danger' : (workflow.quota_used / workflow.quota_limit) > 0.7 ? 'warning' : ''}`}
                    style={{ width: `${Math.min(((workflow.quota_used || 0) / (workflow.quota_limit || 1)) * 100, 100)}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Runs Tab */}
        {activeTab === 'runs' && (
          <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '1.5rem' }}>
            {/* Runs List */}
            <div className="card">
              <h3 style={{ marginBottom: '0.75rem' }}>Workflow Runs</h3>
              {runs.length === 0 && !activeRun ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No runs yet. Click "Run Workflow" to start.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {activeRun && !runs.find(r => r.id === activeRun) && (
                    <div
                      onClick={() => viewRun(activeRun)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.75rem',
                        padding: '0.6rem', background: 'rgba(99, 102, 241, 0.05)',
                        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                        border: '1px solid var(--accent-blue)'
                      }}
                    >
                      <span className="status-badge running"><span className="status-dot"></span> running</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Current run</span>
                    </div>
                  )}
                  {runs.map(run => (
                    <div
                      key={run.id}
                      onClick={() => viewRun(run.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.75rem',
                        padding: '0.6rem', background: activeRun === run.id ? 'rgba(99, 102, 241, 0.05)' : 'var(--bg-glass)',
                        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                        border: activeRun === run.id ? '1px solid var(--accent-blue)' : '1px solid transparent'
                      }}
                    >
                      <span className={`status-badge ${run.status}`}><span className="status-dot"></span> {run.status}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.78rem' }}>{run.trigger_type}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {new Date(run.started_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Step-by-Step Run Viewer */}
            <div className="card">
              {!activeRun ? (
                <div className="empty-state">
                  <div className="empty-icon">📊</div>
                  <p>Select a run to view step-by-step progress</p>
                </div>
              ) : stepRuns.length === 0 ? (
                <div className="loading-state">
                  {runs.find(r => r.id === activeRun)?.status === 'running' || runs.find(r => r.id === activeRun)?.status === 'pending' || runs.find(r => r.id === activeRun)?.status === 'paused' ? (
                    <>
                      <div className="spinner"></div>
                      <span>Waiting for step data...</span>
                    </>
                  ) : (
                    <div style={{ textAlign: 'center' }}>
                      <span style={{ fontSize: '1.2rem', display: 'block', marginBottom: '0.5rem' }}>🗑️</span>
                      <span style={{ color: 'var(--text-muted)' }}>No step data available.</span>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>This usually happens if the workflow was edited and saved after this run occurred, which clears old step definitions.</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <h3 style={{ marginBottom: '1rem' }}>
                    Run Progress
                    {runPolling && <span className="spinner" style={{ width: 14, height: 14, marginLeft: 8, display: 'inline-block', verticalAlign: 'middle' }}></span>}
                  </h3>
                  <div className="run-viewer">
                    {stepRuns.map((sr, idx) => (
                      <div key={sr.id} className={`run-step status-${sr.status}`}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span className={`step-icon ${sr.step_type}`} style={{ width: 28, height: 28, fontSize: '0.85rem' }}>
                              {STEP_TYPES.find(t => t.type === sr.step_type)?.icon || '❓'}
                            </span>
                            <div>
                              <div className="run-step-name">{sr.step_name || sr.step_type}</div>
                              <div className="run-step-status">
                                <span className={`status-badge ${sr.status}`}><span className="status-dot"></span> {sr.status}</span>
                                {sr.attempt_count > 1 && <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: 'var(--accent-amber)' }}>({sr.attempt_count} attempts)</span>}
                              </div>
                            </div>
                          </div>

                          {/* Output */}
                          {sr.output && Object.keys(sr.output).length > 0 && sr.status !== 'pending' && (
                            <div className="run-step-output">
                              {sr.output.response ? sr.output.response.substring(0, 500) : JSON.stringify(sr.output, null, 2).substring(0, 500)}
                            </div>
                          )}

                          {/* Error */}
                          {sr.error && (
                            <div className="error-alert" style={{ marginTop: '0.5rem', fontSize: '0.78rem' }}>
                              {sr.error}
                            </div>
                          )}

                          {/* Approval Prompt */}
                          {sr.status === 'paused' && sr.step_type === 'approval_gate' && (
                            <div className="approval-prompt">
                              <div>
                                <p style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                  Awaiting Approval
                                </p>
                                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                                  {sr.step_config?.message || sr.output?.message || 'An authorized user must approve this step to continue.'}
                                </p>
                              </div>
                              {(role === 'owner' || role === 'editor') && (
                                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                                  <button className="btn btn-success btn-sm" onClick={() => approveStep(sr.id)}>
                                    ✓ Approve
                                  </button>
                                  <button className="btn btn-sm" style={{ background: 'var(--accent-red)', color: 'white', border: 'none' }} onClick={() => rejectStep(sr.id)}>
                                    ✕ Reject
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Approved info */}
                          {sr.approved_by && (
                              <div style={{ fontSize: '0.72rem', color: 'var(--accent-green)', marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                Approved at {new Date(sr.approved_at).toLocaleTimeString()}
                              </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>
        ))}
      </div>

      {/* Add Step Modal */}
      {showAddStep && showAddStep === 'modal' && (
        <div className="modal-overlay" onClick={() => setShowAddStep(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add Step</h3>
              <button className="modal-close" onClick={() => setShowAddStep(false)}>✕</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
