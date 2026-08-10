'use client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';

const DEMO_ACCOUNTS = [
  { email: 'alice@orga.com', name: 'Alice', org: 'Alpha Corp', role: 'owner', password: 'password123' },
  { email: 'bob@orga.com', name: 'Bob', org: 'Alpha Corp', role: 'editor', password: 'password123' },
  { email: 'charlie@orga.com', name: 'Charlie', org: 'Alpha Corp', role: 'viewer', password: 'password123' },
  { email: 'dave@orgb.com', name: 'Dave', org: 'Beta Inc', role: 'owner', password: 'password123' },
  { email: 'eve@orgb.com', name: 'Eve', org: 'Beta Inc', role: 'editor', password: 'password123' },
];

export default function LoginPage() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [role, setRole] = useState('viewer');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, signup } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isSignUp) {
        await signup(name, email, password, orgName, role);
      } else {
        await login(email, password);
      }
      router.push('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const quickLogin = async (account) => {
    setEmail(account.email);
    setPassword(account.password);
    setError('');
    setLoading(true);
    try {
      await login(account.email, account.password);
      router.push('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card glass-card">
        <div className="login-logo">
          <div className="icon">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span>FlowForge</span>
        </div>

        <form onSubmit={handleSubmit}>
          {error && <div className="error-alert">{error}</div>}
          
          {isSignUp && (
            <>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  id="signup-name"
                  type="text"
                  className="form-input"
                  placeholder="Jane Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Organization Name</label>
                <input
                  id="signup-org"
                  type="text"
                  className="form-input"
                  placeholder="e.g. Alpha Corp"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <select
                  id="signup-role"
                  className="form-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  required
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
            </>
          )}

          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              id="login-email"
              type="email"
              className="form-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              id="login-password"
              type="password"
              className="form-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button id="login-submit" type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
            {loading ? <><div className="spinner"></div> {isSignUp ? 'Signing up...' : 'Signing in...'}</> : (isSignUp ? 'Sign Up' : 'Sign In')}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.85rem' }}>
          {isSignUp ? (
            <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setIsSignUp(false); setError(''); }} style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>Sign In</a></>
          ) : (
            <>Don't have an account? <a href="#" onClick={(e) => { e.preventDefault(); setIsSignUp(true); setError(''); }} style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>Sign up instead</a></>
          )}
        </div>

        <div className="login-divider">Quick Login</div>

        <div className="demo-accounts">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              className="demo-account-btn"
              onClick={() => quickLogin(account)}
              disabled={loading}
            >
              <div className="user-avatar">{account.name[0]}</div>
              <div className="demo-account-info">
                <div className="demo-account-name">{account.name}</div>
                <div className="demo-account-detail">{account.org} • {account.email}</div>
              </div>
              <span className={`role-badge ${account.role}`}>{account.role}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
