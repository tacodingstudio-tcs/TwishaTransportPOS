// src/store/auth.store.ts
// Zustand store for authentication state.
// Both tokens persisted to localStorage. Owners/managers often leave a
// browser tab open for an entire workday — the refresh token is what
// keeps that session alive past the 15-minute access token window
// without ever forcing a re-login mid-shift.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AuthUser {
  id:    string
  name:  string
  phone: string
  role:  'owner' | 'manager' | 'cashier' | 'viewer'
  lang:  string
}

export interface AuthTenant {
  id:   string
  name: string
  plan: string
}

export interface AuthBranch {
  id:          string
  name:        string
  domainType:  string
  domainConfig: Record<string, unknown>
  stateCode:   string | null
}

interface AuthState {
  accessToken:  string | null
  refreshToken: string | null
  accessTokenExpiresAt: number | null
  user:     AuthUser | null
  tenant:   AuthTenant | null
  branch:   AuthBranch | null

  // Actions
  setAuth: (
    accessToken: string, refreshToken: string, accessTokenExpiresIn: number,
    user: AuthUser, tenant: AuthTenant, branch: AuthBranch
  ) => void
  setBranch: (branch: AuthBranch, accessToken: string) => void
  // Called by lib/api.ts after a silent refresh succeeds
  setTokens: (accessToken: string, refreshToken: string, accessTokenExpiresIn: number) => void
  logout:    () => void

  // Computed helpers
  isLoggedIn:  () => boolean
  isOwner:     () => boolean
  canManage:   () => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null, refreshToken: null, accessTokenExpiresAt: null,
      user: null, tenant: null, branch: null,

      setAuth: (accessToken, refreshToken, accessTokenExpiresIn, user, tenant, branch) =>
        set({
          accessToken, refreshToken,
          accessTokenExpiresAt: Date.now() + accessTokenExpiresIn * 1000,
          user, tenant, branch,
        }),

      setBranch: (branch, accessToken) =>
        set({ branch, accessToken }),

      setTokens: (accessToken, refreshToken, accessTokenExpiresIn) =>
        set({
          accessToken, refreshToken,
          accessTokenExpiresAt: Date.now() + accessTokenExpiresIn * 1000,
        }),

      logout: () =>
        set({
          accessToken: null, refreshToken: null, accessTokenExpiresAt: null,
          user: null, tenant: null, branch: null,
        }),

      isLoggedIn: () => {
        const { accessToken, accessTokenExpiresAt } = get()
        if (!accessToken) return false
        // Treat as logged-out if the access token has already expired;
        // the silent-refresh interceptor will renew it on the next API call.
        if (accessTokenExpiresAt !== null && Date.now() > accessTokenExpiresAt) return false
        return true
      },
      isOwner:    () => get().user?.role === 'owner',
      canManage:  () => ['owner', 'manager'].includes(get().user?.role ?? ''),
    }),
    {
      name: 'billing-auth',
      version: 0,
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        accessTokenExpiresAt: state.accessTokenExpiresAt,
        user:   state.user,
        tenant: state.tenant,
        branch: state.branch,
      }),
    }
  )
)
