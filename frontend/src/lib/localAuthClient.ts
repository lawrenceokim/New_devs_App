// Local authentication client to replace Supabase
interface AuthUser {
  id: string;
  email: string;
  name?: string;
  is_admin?: boolean;
  tenant_id?: string;
  app_metadata?: any;
  user_metadata?: any;
  created_at?: string;
}

interface AuthSession {
  access_token: string;
  refresh_token?: string;
  user: AuthUser;
  token_type: string;
  expires_in?: number;
  expires_at?: number;
}

interface AuthResponse {
  user: AuthUser | null;
  session: AuthSession | null;
  error: Error | null;
}

interface SignInCredentials {
  email: string;
  password: string;
}

class LocalAuthClient {
  private subscribers: ((event: string, session: AuthSession | null) => void)[] = [];
  private session: AuthSession | null = null;
  private storageKey = 'base360-auth-token';

  constructor() {
    this.loadSession();
  }

  private getApiUrl(): string {
    return import.meta.env.VITE_API_URL || import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';
  }

  private decodeTokenPayload(token: string): any | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const paddedPayload = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      return JSON.parse(atob(paddedPayload));
    } catch (error) {
      console.warn('[LocalAuth] Failed to decode JWT payload:', error);
      return null;
    }
  }

  private normalizeSession(session: Partial<AuthSession> & { access_token: string }): AuthSession {
    const payload = this.decodeTokenPayload(session.access_token);
    const baseUser = session.user
      || this.session?.user
      || {
        id: payload?.id || payload?.sub || '',
        email: payload?.email || '',
      };

    const tenantId = baseUser.tenant_id
      || payload?.tenant_id
      || payload?.app_metadata?.tenant_id
      || payload?.user_metadata?.tenant_id;

    const user: AuthUser = {
      ...baseUser,
      app_metadata: baseUser.app_metadata || payload?.app_metadata || {},
      user_metadata: baseUser.user_metadata || payload?.user_metadata || {},
      tenant_id: tenantId || baseUser.tenant_id,
    };

    const expiresAt = session.expires_at || payload?.exp;
    const expiresIn = expiresAt ? Math.max(0, expiresAt - Math.floor(Date.now() / 1000)) : session.expires_in;

    return {
      ...session,
      access_token: session.access_token,
      token_type: session.token_type || 'bearer',
      user,
      expires_at: expiresAt,
      expires_in: expiresIn,
    };
  }

  private isSessionExpired(session: AuthSession): boolean {
    if (!session.expires_at) return false;
    return session.expires_at * 1000 <= Date.now();
  }

  private notifySubscribers(event: string, session: AuthSession | null) {
    console.log(`📣 [LocalAuth] Notifying ${this.subscribers.length} subscribers of event: ${event}`);
    this.subscribers.forEach((callback) => {
      try {
        callback(event, session);
      } catch (e) {
        console.error('📣 [LocalAuth] Error in subscriber callback:', e);
      }
    });
  }

  private saveSession(session: AuthSession | null) {
    this.session = session;
    if (session) {
      localStorage.setItem(this.storageKey, JSON.stringify(session));
      this.notifySubscribers('SIGNED_IN', session);
    } else {
      localStorage.removeItem(this.storageKey);
      this.notifySubscribers('SIGNED_OUT', null);
    }
  }

  private loadSession() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = this.normalizeSession(JSON.parse(stored));
        if (this.isSessionExpired(parsed)) {
          localStorage.removeItem(this.storageKey);
          this.session = null;
          return;
        }

        this.session = parsed;
        localStorage.setItem(this.storageKey, JSON.stringify(parsed));
      }
    } catch (error) {
      console.warn('[LocalAuth] Failed to load session from storage:', error);
      localStorage.removeItem(this.storageKey);
    }
  }

  async signInWithPassword(credentials: SignInCredentials): Promise<AuthResponse> {
    try {
      const response = await fetch(`${this.getApiUrl()}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      }

      if (data.error) {
        throw new Error(data.error);
      }

      const session = this.normalizeSession({
        access_token: data.access_token,
        token_type: data.token_type || 'bearer',
        user: data.user,
      });

      this.saveSession(session);

      return {
        user: data.user,
        session: session,
        error: null,
      };
    } catch (error: any) {
      console.error('[LocalAuth] Sign in failed:', error);
      return {
        user: null,
        session: null,
        error: error,
      };
    }
  }

  async signOut(): Promise<{ error: Error | null }> {
    try {
      // Call backend logout endpoint if needed
      if (this.session?.access_token) {
        try {
          await fetch(`${this.getApiUrl()}/api/v1/auth/logout`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.session.access_token}`,
            },
          });
        } catch (logoutError) {
          console.warn('[LocalAuth] Backend logout failed (continuing):', logoutError);
        }
      }

      this.saveSession(null);

      return { error: null };
    } catch (error: any) {
      console.error('[LocalAuth] Sign out failed:', error);
      return { error: error };
    }
  }

  async getSession(): Promise<{ data: { session: AuthSession | null }, error: Error | null }> {
    // Check if current session is still valid
    if (this.session?.access_token) {
      if (this.isSessionExpired(this.session)) {
        const error = new Error('Session expired');
        this.saveSession(null);
        return { data: { session: null }, error };
      }

      try {
        // Verify token is still valid by calling a protected endpoint
        const response = await fetch(`${this.getApiUrl()}/api/v1/auth/me`, {
          headers: {
            'Authorization': `Bearer ${this.session.access_token}`,
          },
        });

        if (response.ok) {
          const userData = await response.json();
          this.session = this.normalizeSession({
            ...this.session,
            user: {
              ...this.session.user,
              ...userData,
            },
          });
          localStorage.setItem(this.storageKey, JSON.stringify(this.session));
          return { data: { session: this.session }, error: null };
        }

        if (response.status === 401) {
          // Confirmed invalid token, clear it
          const error = new Error('Session invalid');
          this.saveSession(null);
          return { data: { session: null }, error };
        }

        console.warn('[LocalAuth] Session validation returned non-auth error, preserving session:', response.status);
        return { data: { session: this.session }, error: null };
      } catch (error) {
        console.warn('[LocalAuth] Session validation failed:', error);
        return { data: { session: this.session }, error: null };
      }
    }

    return { data: { session: null }, error: null };
  }

  async getUser(token?: string): Promise<{ data: { user: AuthUser | null }, error: Error | null, user: AuthUser | null }> {
    const tokenToUse = token || this.session?.access_token;

    if (!tokenToUse) {
      return { data: { user: null }, error: null, user: null };
    }

    try {
      const response = await fetch(`${this.getApiUrl()}/api/v1/auth/me`, {
        headers: {
          'Authorization': `Bearer ${tokenToUse}`,
        },
      });

      if (response.ok) {
        const userData = await response.json();
        const user = {
          ...(this.session?.user || {}),
          ...userData,
        } as AuthUser;

        if (this.session && tokenToUse === this.session.access_token) {
          this.session = this.normalizeSession({
            ...this.session,
            user,
          });
          localStorage.setItem(this.storageKey, JSON.stringify(this.session));
        }

        return { data: { user }, error: null, user };
      }

      if (response.status === 401) {
        const error = new Error('Invalid authentication token');
        if (this.session && tokenToUse === this.session.access_token) {
          this.saveSession(null);
        }
        return { data: { user: null }, error, user: null };
      }

      console.warn('[LocalAuth] User validation returned non-auth error, preserving session:', response.status);
      const fallbackUser = this.session?.user || null;
      return { data: { user: fallbackUser }, error: null, user: fallbackUser };
    } catch (error) {
      console.error('[LocalAuth] Get user failed:', error);
      const fallbackUser = this.session?.user || null;
      return { data: { user: fallbackUser }, error: null, user: fallbackUser };
    }
  }

  async refreshSession(): Promise<{ data: { session: AuthSession | null }, error: Error | null }> {
    if (!this.session?.access_token) {
      return { data: { session: null }, error: new Error('No active session') };
    }

    if (this.isSessionExpired(this.session)) {
      const error = new Error('Session expired');
      this.saveSession(null);
      return { data: { session: null }, error };
    }

    return { data: { session: this.session }, error: null };
  }

  async setSession(session: Partial<AuthSession> & { access_token: string }): Promise<{ error: Error | null }> {
    try {
      this.saveSession(this.normalizeSession(session));
      return { error: null };
    } catch (error: any) {
      return { error: error };
    }
  }

  // Mock auth state change handler for compatibility
  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void) {
    // Register subscriber
    this.subscribers.push(callback);

    // Call immediately with current state
    callback('INITIAL_SESSION', this.session);

    // Return unsubscribe function
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.subscribers = this.subscribers.filter(cb => cb !== callback);
          }
        }
      }
    };
  }

  // Mock admin interface for compatibility
  get auth() {
    return {
      admin: {
        getUser: this.getUser.bind(this),
        getUserById: (id: string) => this.getUser(),
        listUsers: () => Promise.resolve([]), // Mock implementation
      },
      signInWithPassword: this.signInWithPassword.bind(this),
      signOut: this.signOut.bind(this),
      getSession: this.getSession.bind(this),
      getUser: this.getUser.bind(this),
      refreshSession: this.refreshSession.bind(this),
      setSession: this.setSession.bind(this),
      onAuthStateChange: this.onAuthStateChange.bind(this),
    };
  }
}


export const localAuthClient = new LocalAuthClient();
export default localAuthClient;
