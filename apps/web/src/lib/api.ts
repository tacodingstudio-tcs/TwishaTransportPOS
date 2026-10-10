// src/lib/api.ts
// Axios instance with JWT auth interceptor.
// All API calls go through this — never use fetch() directly.

import axios, { type AxiosError } from 'axios'
import toast from 'react-hot-toast'
import { useAuthStore } from '@/store/auth.store'

export const api = axios.create({
  baseURL: '/api',          // proxied to localhost:3000 by Vite in dev
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

// ── Request interceptor: attach JWT token ─────────────────────────────────────
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`
  }
  return config
})

// ── Silent refresh on 401 (mirrors apps/mobile/src/lib/apiClient.ts) ──────────
// An owner/manager often keeps the dashboard open in a browser tab for an
// entire workday. Without this, every 15 minutes their next click would
// bounce them to /login with no warning — refreshing transparently in the
// background means the access token's short lifetime is invisible to them.
let isRefreshing = false
let refreshSubscribers: Array<(token: string) => void> = []

function subscribeToRefresh(cb: (token: string) => void) {
  refreshSubscribers.push(cb)
}
function notifyRefreshSubscribers(token: string) {
  refreshSubscribers.forEach((cb) => cb(token))
  refreshSubscribers = []
}

async function performRefresh(): Promise<string | null> {
  const refreshToken = useAuthStore.getState().refreshToken
  if (!refreshToken) return null

  try {
    // Plain axios, not `api` — avoids re-entering this same interceptor
    // chain if /auth/refresh itself ever returns a 401.
    const response = await axios.post('/api/auth/refresh', { refreshToken })
    const { accessToken, refreshToken: newRefreshToken, accessTokenExpiresIn } = response.data

    // Update Zustand store so components reading from the store get the new token immediately.
    // The persist middleware will sync this back to localStorage automatically.
    useAuthStore.getState().setTokens(accessToken, newRefreshToken, accessTokenExpiresIn)

    return accessToken
  } catch {
    useAuthStore.getState().logout()
    return null
  }
}

// ── Response interceptor: handle errors globally ──────────────────────────────
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<{ error?: string; message?: string; issues?: Record<string, string[]> }>) => {
    const originalRequest = error.config as (typeof error.config & { _retry?: boolean }) | undefined

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true

      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeToRefresh((newToken) => {
            if (!newToken) { window.location.href = '/login'; return }
            originalRequest.headers!['Authorization'] = `Bearer ${newToken}`
            resolve(api(originalRequest))
          })
        })
      }

      isRefreshing = true
      const newToken = await performRefresh()
      isRefreshing = false

      if (newToken) {
        notifyRefreshSubscribers(newToken)
        originalRequest.headers!['Authorization'] = `Bearer ${newToken}`
        return api(originalRequest)
      }

      // Refresh token itself is invalid/expired — no way to recover silently.
      notifyRefreshSubscribers('')
      window.location.href = '/login'
      return Promise.reject(error)
    }

    if (error.response?.status === 422) {
      // Zod validation errors — show field-level messages
      const issues = error.response.data?.issues
      if (issues) {
        const msgs = Object.entries(issues)
          .map(([field, errs]) => `${field}: ${errs.join(', ')}`)
          .join('\n')
        toast.error(`Validation error:\n${msgs}`, { duration: 5000 })
      }
      return Promise.reject(error)
    }

    if (error.response?.status === 409) {
      toast.error(error.response.data?.error ?? 'Duplicate entry')
      return Promise.reject(error)
    }

    if (error.response?.status === 404) {
      // Let individual queries handle 404 — don't show global toast
      return Promise.reject(error)
    }

    if (!error.response || error.code === 'ERR_NETWORK') {
      toast.error('Cannot reach the server. If it was idle, wait a minute and try again.')
      return Promise.reject(error)
    }

    // Generic server error
    const msg = error.response.data?.error ?? error.response.data?.message ?? 'Something went wrong'
    toast.error(msg)
    return Promise.reject(error)
  }
)

// ── Typed API helpers ──────────────────────────────────────────────────────────
// Each function corresponds to one API endpoint.
// Return types are inferred — add explicit interfaces as needed.

export const authApi = {
  // Owners sign in with their own phone; staff pass the business (owner) phone as tenantPhone.
  login: (phone: string, pin: string, tenantPhone?: string) =>
    api.post('/auth/login', { tenantPhone: tenantPhone || phone, phone, pin }, { timeout: 75_000 }).then((r) => r.data),

  refresh: (refreshToken: string) =>
    api.post('/auth/refresh', { refreshToken }).then((r) => r.data),

  logout: (refreshToken: string) =>
    api.post('/auth/logout', { refreshToken }).then((r) => r.data),

  logoutAllDevices: () =>
    api.post('/auth/logout-all-devices').then((r) => r.data),

  switchBranch: (branchId: string) =>
    api.post('/auth/switch-branch', { branchId }).then((r) => r.data),
}

export const invoiceApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/invoices', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/invoices/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/invoices', data, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    }).then((r) => r.data),

  cancel: (id: string) =>
    api.post(`/invoices/${id}/cancel`).then((r) => r.data),

  recordPayment: (id: string, data: unknown) =>
    api.post(`/invoices/${id}/payment`, data, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    }).then((r) => r.data),

  dailySummary: () =>
    api.get('/invoices/summary/daily').then((r) => r.data),

  weeklySummary: () =>
    api.get('/invoices/summary/weekly').then((r) => r.data),

  pdfUrl: (id: string) => `/api/invoices/${id}/pdf`,

  sendReceipt: (id: string, data: { channel: 'whatsapp' | 'email'; to?: string; businessName?: string }) =>
    api.post(`/invoices/${id}/send-receipt`, data).then((r) => r.data),

  createReturn: (id: string, data?: unknown) =>
    api.post(`/invoices/${id}/return`, data ?? {}).then((r) => r.data),

  createDebitNote: (id: string, data?: unknown) =>
    api.post(`/invoices/${id}/debit-note`, data ?? {}).then((r) => r.data),

  generateIrn: (id: string) =>
    api.post(`/invoices/${id}/generate-irn`).then((r) => r.data),

  generateEway: (id: string, data: unknown) =>
    api.post(`/invoices/${id}/generate-eway`, data).then((r) => r.data),

  linkedDocs: (id: string) =>
    api.get(`/invoices/${id}/linked-docs`).then((r) => r.data),
}

export const tenantApi = {
  gstinLookup: (gstin: string) =>
    api.get(`/tenants/gstin/${encodeURIComponent(gstin)}`).then((r) => r.data),
}

export const productApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/products', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/products/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/products', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/products/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    api.delete(`/products/${id}`).then((r) => r.data),

  byBarcode: (code: string) =>
    api.get(`/products/barcode/${code}`).then((r) => r.data),

  imageUrl: (id: string) => {
    const token = (JSON.parse(localStorage.getItem('billing-auth') ?? '{}')?.state?.accessToken ?? '') as string
    return `/api/products/${id}/image${token ? `?token=${token}` : ''}`
  },

  uploadImage: (id: string, imageBase64: string, imageMime: string) =>
    api.put(`/products/${id}/image`, { imageBase64, imageMime }).then((r) => r.data),

  suggestHSN: (id: string) =>
    api.post(`/products/${id}/suggest-hsn`).then((r) => r.data),

  confirmHSN: (id: string, hsnCode: string, gstRate: number) =>
    api.post(`/products/${id}/confirm-hsn`, { hsnCode, gstRate }).then((r) => r.data),

  adjustStock: (id: string, qty: number, reason: string) =>
    api.post(`/products/${id}/stock-adjustment`, { qty, reason }).then((r) => r.data),

  lowStock: () =>
    api.get('/products/low-stock').then((r) => r.data),

  bulkImport: (rows: unknown[]) =>
    api.post('/products/bulk-import', { rows }).then((r) => r.data),
}

export const expenseApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/expenses', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/expenses/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/expenses', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/expenses/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    api.delete(`/expenses/${id}`).then((r) => r.data),

  summary: (params?: { from?: string; to?: string; branchId?: string }) =>
    api.get('/expenses/summary', { params }).then((r) => r.data),

  categories: () =>
    api.get('/expenses/categories').then((r) => r.data),
}

export const partyApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/parties', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/parties/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/parties', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/parties/${id}`, data).then((r) => r.data),

  statement: (id: string, params?: Record<string, unknown>) =>
    api.get(`/parties/${id}/statement`, { params }).then((r) => r.data),

  udhaarSummary: () =>
    api.get('/parties/udhaar/summary').then((r) => r.data),
}

export const stockApi = {
  all: () => api.get('/stock').then((r) => r.data),
}

export const supplierApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/inventory/suppliers', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/inventory/suppliers/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/inventory/suppliers', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/inventory/suppliers/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    api.delete(`/inventory/suppliers/${id}`).then((r) => r.data),
}

export const purchaseOrderApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/inventory/purchase-orders', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/inventory/purchase-orders/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/inventory/purchase-orders', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/inventory/purchase-orders/${id}`, data).then((r) => r.data),

  cancel: (id: string) =>
    api.post(`/inventory/purchase-orders/${id}/cancel`).then((r) => r.data),

  recordPayment: (id: string, data: unknown) =>
    api.post(`/inventory/purchase-orders/${id}/payment`, data).then((r) => r.data),
}

export const grnApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/grn', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/grn/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/grn', data).then((r) => r.data),

  cancel: (id: string) =>
    api.post(`/grn/${id}/cancel`).then((r) => r.data),

  matchCheck: (invoiceId: string) =>
    api.get(`/grn/match/${invoiceId}`).then((r) => r.data),
}

export const stockAdjustmentApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/inventory/adjustments', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/inventory/adjustments/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/inventory/adjustments', data).then((r) => r.data),

  post: (id: string) =>
    api.post(`/inventory/adjustments/${id}/post`).then((r) => r.data),

  cancel: (id: string) =>
    api.post(`/inventory/adjustments/${id}/cancel`).then((r) => r.data),
}

export const stockTransferApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/inventory/transfers', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/inventory/transfers/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/inventory/transfers', data).then((r) => r.data),

  dispatch: (id: string) =>
    api.post(`/inventory/transfers/${id}/dispatch`).then((r) => r.data),

  receive: (id: string, data: unknown) =>
    api.post(`/inventory/transfers/${id}/receive`, data).then((r) => r.data),
}

export const stockSummaryApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/stock', { params }).then((r) => r.data),

  ledger: (productId: string, params?: Record<string, unknown>) =>
    api.get(`/stock/ledger/${productId}`, { params }).then((r) => r.data),

  expiryAlerts: (days = 90) =>
    api.get('/stock/expiry-alerts', { params: { days } }).then((r) => r.data),
}

export const branchApi = {
  list: () =>
    api.get('/branches').then((r) => r.data),

  create: (data: unknown) =>
    api.post('/branches', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/branches/${id}`, data).then((r) => r.data),

  deactivate: (id: string) =>
    api.post(`/branches/${id}/deactivate`).then((r) => r.data),

  activate: (id: string) =>
    api.post(`/branches/${id}/activate`).then((r) => r.data),
}

export const aiApi = {
  extractInvoice: (text: string) =>
    api.post('/ai/extract-invoice', { text }).then((r) => r.data),

  scanBill: (imageBase64: string, mediaType = 'image/jpeg') =>
    api.post('/ai/scan-bill', { imageBase64, mediaType }).then((r) => r.data),

  generateReminders: () =>
    api.post('/ai/reminders/generate').then((r) => r.data),

  pendingReminders: () =>
    api.get('/ai/reminders/pending').then((r) => r.data),

  approveReminder: (id: string) =>
    api.post(`/ai/reminders/${id}/approve`).then((r) => r.data),

  rejectReminder: (id: string) =>
    api.post(`/ai/reminders/${id}/reject`).then((r) => r.data),

  insight: () =>
    api.get('/ai/insight').then((r) => r.data),

  reorder: () =>
    api.get('/ai/reorder').then((r) => r.data),

  checkInvoice: (data: { partyId: string | null; grandTotal: number; items: any[] }) =>
    api.post('/ai/check-invoice', data).then((r) => r.data),

  creditRisk: (partyId: string) =>
    api.get(`/ai/credit-risk/${partyId}`).then((r) => r.data),

  extractSupplierBill: (imageBase64: string, mediaType = 'image/jpeg') =>
    api.post('/ai/extract-supplier-bill', { imageBase64, mediaType }).then((r) => r.data),

  categorizeExpense: (description: string, amount: number) =>
    api.post('/ai/categorize-expense', { description, amount }).then((r) => r.data),

  cashflowForecast: (horizon: 7 | 30 = 7) =>
    api.get('/ai/cashflow-forecast', { params: { horizon } }).then((r) => r.data),

  partyDuplicates: () =>
    api.get('/ai/party-duplicates').then((r) => r.data),

  priceAnomaly: (items: Array<{ productId: string; rate: number }>) =>
    api.post('/ai/price-anomaly', { items }).then((r) => r.data),

  gstSummaryAI: (month: string) =>
    api.get('/ai/gst-summary', { params: { month } }).then((r) => r.data),

  demandForecast: () =>
    api.get('/ai/demand-forecast').then((r) => r.data),

  chat: (question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    api.post('/ai/chat', { question, history }).then((r) => r.data),
}

export const analyticsApi = {
  dashboard: (params?: { period?: string; compareWith?: string }) =>
    api.get('/analytics/dashboard', { params }).then((r) => r.data),

  revenueTrend: (params?: { period?: string; groupBy?: string }) =>
    api.get('/analytics/revenue-trend', { params }).then((r) => r.data),

  marginReport: (params?: { period?: string }) =>
    api.get('/analytics/margin-report', { params }).then((r) => r.data),

  topCustomers: (params?: { period?: string; limit?: number }) =>
    api.get('/analytics/top-customers', { params }).then((r) => r.data),

  gstSummary: (params?: { month?: string }) =>
    api.get('/analytics/gst-summary', { params }).then((r) => r.data),

  salesVsPurchases: (params?: { months?: number }) =>
    api.get('/analytics/sales-vs-purchases', { params }).then((r) => r.data),
}

export const reportsApi = {
  gstr1: (params?: { month?: string }) =>
    api.get('/reports/gstr1', { params }).then((r) => r.data),

  dayBook: (params?: { date?: string }) =>
    api.get('/reports/day-book', { params }).then((r) => r.data),

  stockSummary: (params?: { categoryId?: string; lowStockOnly?: boolean }) =>
    api.get('/reports/stock-summary', { params }).then((r) => r.data),

  plStatement: (params?: { from?: string; to?: string }) =>
    api.get('/reports/pl-statement', { params }).then((r) => r.data),

  monthlyComparison: () =>
    api.get('/reports/monthly-comparison').then((r) => r.data),

  cashRegisterGet: (params?: { date?: string }) =>
    api.get('/reports/cash-register', { params }).then((r) => r.data),

  cashRegisterSave: (data: {
    date: string; systemCash: number; countedCash: number
    notes?: string; closedBy?: string
  }) => api.post('/reports/cash-register', data).then((r) => r.data),

  bankAccounts: () =>
    api.get('/reports/bank-accounts').then((r) => r.data),

  bankAccountCreate: (data: {
    name: string; bankName?: string; accountNumber?: string; openingBalance?: number
  }) => api.post('/reports/bank-accounts', data).then((r) => r.data),

  bankReconGet: (params: { month: string; bankAccountId?: string }) =>
    api.get('/reports/bank-reconciliation', { params }).then((r) => r.data),

  bankReconSave: (data: {
    month: string; bankAccountId?: string
    statementBalance: number; bookBalance: number; notes?: string
  }) => api.post('/reports/bank-reconciliation', data).then((r) => r.data),
}

export const staffApi = {
  users: () =>
    api.get('/staff/users').then((r) => r.data),

  getAttendance: (params: { date?: string; month?: string; userId?: string }) =>
    api.get('/staff/attendance', { params }).then((r) => r.data),

  recordAttendance: (data: {
    userId: string; date: string; clockIn?: string; clockOut?: string
    status?: string; notes?: string
  }) => api.post('/staff/attendance', data).then((r) => r.data),

  updateAttendance: (id: string, data: { clockOut?: string; status?: string; notes?: string }) =>
    api.patch(`/staff/attendance/${id}`, data).then((r) => r.data),

  getShifts: (params: { from?: string; to?: string; userId?: string }) =>
    api.get('/staff/shifts', { params }).then((r) => r.data),

  createShift: (data: {
    userId: string; date: string; shiftType?: string
    shiftStart?: string; shiftEnd?: string; notes?: string
  }) => api.post('/staff/shifts', data).then((r) => r.data),

  deleteShift: (id: string) =>
    api.delete(`/staff/shifts/${id}`).then((r) => r.data),
}

export const categoryApi = {
  list: () =>
    api.get('/categories').then((r) => r.data),

  create: (data: { name: string; slug?: string; icon?: string; color?: string; parentId?: string; sortOrder?: number }) =>
    api.post('/categories', data).then((r) => r.data),

  update: (id: string, data: { name?: string; icon?: string; color?: string; sortOrder?: number; isActive?: boolean }) =>
    api.patch(`/categories/${id}`, data).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/categories/${id}`).then((r) => r.data),
}

export const usersApi = {
  list: (params?: { role?: string; isActive?: boolean; search?: string }) =>
    api.get('/users', { params }).then((r) => r.data),

  create: (data: {
    name: string; phone: string; pin: string;
    role?: string; branchIds?: string[]; email?: string; lang?: string
  }) => api.post('/users', data).then((r) => r.data),

  resetPin: (id: string, pin: string) =>
    api.post(`/users/${id}/reset-pin`, { pin }).then((r) => r.data),

  deactivate: (id: string) =>
    api.post(`/users/${id}/deactivate`).then((r) => r.data),

  activate: (id: string) =>
    api.post(`/users/${id}/activate`).then((r) => r.data),

  update: (id: string, data: { name?: string; email?: string; role?: string; branchIds?: string[]; lang?: string }) =>
    api.patch(`/users/${id}`, data).then((r) => r.data),
}

export const broadcastApi = {
  getContacts: (params?: { type?: string; minSpend?: number; minLoyalty?: number; search?: string }) =>
    api.get('/broadcasts/contacts', { params }).then((r) => r.data),

  getCelebrations: (days = 7) =>
    api.get('/broadcasts/celebrations', { params: { days } }).then((r) => r.data),
}

export const brandApi = {
  list: () =>
    api.get('/brands').then((r) => r.data),

  create: (data: { name: string; slug?: string }) =>
    api.post('/brands', data).then((r) => r.data),

  update: (id: string, data: { name?: string; isActive?: boolean }) =>
    api.patch(`/brands/${id}`, data).then((r) => r.data),
}

export const contractApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/contracts', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get(`/contracts/${id}`).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/contracts', data).then((r) => r.data),

  update: (id: string, data: unknown) =>
    api.patch(`/contracts/${id}`, data).then((r) => r.data),

  pause: (id: string) =>
    api.post(`/contracts/${id}/pause`).then((r) => r.data),

  resume: (id: string) =>
    api.post(`/contracts/${id}/resume`).then((r) => r.data),

  cancel: (id: string) =>
    api.delete(`/contracts/${id}`).then((r) => r.data),

  generateInvoice: (id: string) =>
    api.post(`/contracts/${id}/generate-invoice`).then((r) => r.data),
}

export const advanceApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/invoices/advances', { params }).then((r) => r.data),

  create: (data: unknown) =>
    api.post('/invoices/advances', data).then((r) => r.data),

  allocate: (id: string, allocations: Array<{ invoiceId: string; amount: number }>) =>
    api.post(`/invoices/advances/${id}/allocate`, { allocations }).then((r) => r.data),
}

export const approvalApi = {
  pending: () =>
    api.get('/invoices/pending-approvals').then((r) => r.data),

  requestApproval: (id: string) =>
    api.post(`/invoices/${id}/request-approval`).then((r) => r.data),

  approve: (id: string, note?: string) =>
    api.post(`/invoices/${id}/approve`, { note }).then((r) => r.data),

  reject: (id: string, note: string) =>
    api.post(`/invoices/${id}/reject`, { note }).then((r) => r.data),

  convert: (id: string, targetType?: string) =>
    api.post(`/invoices/${id}/convert`, { targetType }).then((r) => r.data),
}

export const discountRulesApi = {
  list:   (params?: { active?: boolean }) =>
    api.get('/discount-rules', { params }).then((r) => r.data),
  create: (data: any) =>
    api.post('/discount-rules', data).then((r) => r.data),
  update: (id: string, data: any) =>
    api.patch(`/discount-rules/${id}`, data).then((r) => r.data),
  remove: (id: string) =>
    api.delete(`/discount-rules/${id}`).then((r) => r.data),
}

// ── Transport / logistics ────────────────────────────────────────────────────
export const transportApi = {
  dashboard: () => api.get('/transport/dashboard').then((r) => r.data),

  // Fleet
  listVehicles:  (params?: Record<string, unknown>) => api.get('/transport/vehicles', { params }).then((r) => r.data),
  getVehicle:    (id: string) => api.get(`/transport/vehicles/${id}`).then((r) => r.data),
  createVehicle: (data: unknown) => api.post('/transport/vehicles', data).then((r) => r.data),
  updateVehicle: (id: string, data: unknown) => api.patch(`/transport/vehicles/${id}`, data).then((r) => r.data),
  deleteVehicle: (id: string) => api.delete(`/transport/vehicles/${id}`).then((r) => r.data),

  listDrivers:   (params?: Record<string, unknown>) => api.get('/transport/drivers', { params }).then((r) => r.data),
  getDriver:     (id: string) => api.get(`/transport/drivers/${id}`).then((r) => r.data),
  createDriver:  (data: unknown) => api.post('/transport/drivers', data).then((r) => r.data),
  updateDriver:  (id: string, data: unknown) => api.patch(`/transport/drivers/${id}`, data).then((r) => r.data),
  deleteDriver:  (id: string) => api.delete(`/transport/drivers/${id}`).then((r) => r.data),

  compliance:    (days?: number) => api.get('/transport/compliance', { params: { days } }).then((r) => r.data),

  // Rate card
  listRoutes:    (params?: Record<string, unknown>) => api.get('/transport/routes', { params }).then((r) => r.data),
  lookupRoute:   (params: Record<string, unknown>) => api.get('/transport/routes/lookup', { params }).then((r) => r.data),
  createRoute:   (data: unknown) => api.post('/transport/routes', data).then((r) => r.data),
  updateRoute:   (id: string, data: unknown) => api.patch(`/transport/routes/${id}`, data).then((r) => r.data),
  deleteRoute:   (id: string) => api.delete(`/transport/routes/${id}`).then((r) => r.data),
  cities:        () => api.get('/transport/cities').then((r) => r.data as string[]),

  // Lorry receipts
  listLrs:       (params?: Record<string, unknown>) => api.get('/transport/lrs', { params }).then((r) => r.data),
  getLr:         (id: string) => api.get(`/transport/lrs/${id}`).then((r) => r.data),
  createLr:      (data: unknown) => api.post('/transport/lrs', data).then((r) => r.data),
  bulkLrs:       (data: unknown) => api.post('/transport/lrs/bulk', data, { timeout: 60_000 }).then((r) => r.data),
  updateLr:      (id: string, data: unknown) => api.patch(`/transport/lrs/${id}`, data).then((r) => r.data),
  assignLr:      (id: string, tripId: string) => api.post(`/transport/lrs/${id}/assign`, { tripId }).then((r) => r.data),
  unassignLr:    (id: string) => api.post(`/transport/lrs/${id}/unassign`).then((r) => r.data),
  deliverLr:     (id: string, data?: unknown) => api.post(`/transport/lrs/${id}/deliver`, data ?? {}).then((r) => r.data),
  podLr:         (id: string, data?: unknown) => api.post(`/transport/lrs/${id}/pod`, data ?? {}).then((r) => r.data),
  collectLr:     (id: string, amount: number) => api.post(`/transport/lrs/${id}/collect`, { amount }).then((r) => r.data),
  cancelLr:      (id: string, reason: string) => api.post(`/transport/lrs/${id}/cancel`, { reason }).then((r) => r.data),
  ewayExpiring:  (hours = 24) => api.get('/transport/lrs-eway-expiring', { params: { hours } }).then((r) => r.data),
  ewayValidity:  (params: Record<string, unknown>) => api.get('/transport/utils/eway-validity', { params }).then((r) => r.data),

  // Trips
  listTrips:     (params?: Record<string, unknown>) => api.get('/transport/trips', { params }).then((r) => r.data),
  getTrip:       (id: string) => api.get(`/transport/trips/${id}`).then((r) => r.data),
  createTrip:    (data: unknown) => api.post('/transport/trips', data).then((r) => r.data),
  updateTrip:    (id: string, data: unknown) => api.patch(`/transport/trips/${id}`, data).then((r) => r.data),
  startTrip:     (id: string, data?: unknown) => api.post(`/transport/trips/${id}/start`, data ?? {}).then((r) => r.data),
  completeTrip:  (id: string, data?: unknown) => api.post(`/transport/trips/${id}/complete`, data ?? {}).then((r) => r.data),
  cancelTrip:    (id: string, reason: string) => api.post(`/transport/trips/${id}/cancel`, { reason }).then((r) => r.data),
  addTripLrs:    (id: string, lrIds: string[]) => api.post(`/transport/trips/${id}/lrs`, { lrIds }).then((r) => r.data),
  removeTripLr:  (id: string, lrId: string) => api.delete(`/transport/trips/${id}/lrs/${lrId}`).then((r) => r.data),

  // Expenses
  listExpenses:  (params?: Record<string, unknown>) => api.get('/transport/expenses', { params }).then((r) => r.data),
  createExpense: (data: unknown) => api.post('/transport/expenses', data).then((r) => r.data),
  deleteExpense: (id: string) => api.delete(`/transport/expenses/${id}`).then((r) => r.data),

  // Billing
  billCandidates: (params?: Record<string, unknown>) => api.get('/transport/bills/candidates', { params }).then((r) => r.data),
  tdsPosition: (invoiceId: string) => api.get(`/transport/bills/${invoiceId}/tds`).then((r) => r.data),
  recordTds:   (invoiceId: string, data: unknown) => api.post(`/transport/bills/${invoiceId}/tds`, data).then((r) => r.data),
  createBill: (data: unknown, idempotencyKey?: string) =>
    api.post('/transport/bills', data, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined)
      .then((r) => r.data),

  // Reports
  tripPnl:       (params?: Record<string, unknown>) => api.get('/transport/reports/trip-pnl', { params }).then((r) => r.data),
  vehiclePnl:    (params?: Record<string, unknown>) => api.get('/transport/reports/vehicle-pnl', { params }).then((r) => r.data),
  partyBusiness: (params?: Record<string, unknown>) => api.get('/transport/reports/party-business', { params }).then((r) => r.data),
}

/** Pulls the server's human-readable message out of an axios failure. */
export function apiError(err: unknown, fallback = 'Something went wrong'): string {
  const e = err as AxiosError<{ error?: string; message?: string; detail?: string[] }>
  const d = e?.response?.data
  return d?.message ?? d?.detail?.[0] ?? d?.error ?? e?.message ?? fallback
}
