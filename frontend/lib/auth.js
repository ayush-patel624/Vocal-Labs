'use client';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_ACTION_HANDLER_URL || 'http://localhost:3001';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [currentOrg, setCurrentOrg] = useState(null);
  const [currentRole, setCurrentRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem('auth_token');
    const savedOrg = localStorage.getItem('current_org');
    if (savedToken) {
      setToken(savedToken);
      fetchUser(savedToken, savedOrg);
    } else {
      setLoading(false);
    }
  }, []);

  const fetchUser = async (authToken, savedOrgId) => {
    try {
      const res = await fetch(`${API_URL}/auth/me`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error('Unauthorized');
      const data = await res.json();
      setUser(data.user);
      setOrganizations(data.organizations);
      
      const org = savedOrgId 
        ? data.organizations.find(o => o.org_id === savedOrgId) || data.organizations[0]
        : data.organizations[0];
      
      if (org) {
        setCurrentOrg(org);
        setCurrentRole(org.role);
      }
    } catch (e) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('current_org');
      setToken(null);
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Login failed');
    }
    
    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
    setOrganizations(data.organizations);
    localStorage.setItem('auth_token', data.token);
    
    if (data.organizations.length > 0) {
      const org = data.organizations[0];
      setCurrentOrg(org);
      setCurrentRole(org.role);
      localStorage.setItem('current_org', org.org_id);
    }
    
    return data;
  };

  const signup = async (name, email, password, orgName, role) => {
    const res = await fetch(`${API_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, orgName, role })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Signup failed');
    }
    
    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
    setOrganizations(data.organizations);
    localStorage.setItem('auth_token', data.token);
    
    if (data.organizations.length > 0) {
      const org = data.organizations[0];
      setCurrentOrg(org);
      setCurrentRole(org.role);
      localStorage.setItem('current_org', org.org_id);
    }
    
    return data;
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setOrganizations([]);
    setCurrentOrg(null);
    setCurrentRole(null);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('current_org');
  };

  const switchOrg = useCallback((orgId) => {
    const org = organizations.find(o => o.org_id === orgId);
    if (org) {
      setCurrentOrg(org);
      setCurrentRole(org.role);
      localStorage.setItem('current_org', orgId);
    }
  }, [organizations]);

  const apiFetch = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers,
      }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || data.message || `HTTP ${res.status}`);
    }
    return res.json();
  }, [token]);

  return (
    <AuthContext.Provider value={{
      user, token, organizations, currentOrg, currentRole,
      loading, login, signup, logout, switchOrg, apiFetch
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
