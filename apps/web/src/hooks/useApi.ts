// src/hooks/useApi.ts
// React Query hooks that wrap every API call.
// Components import these hooks — never call api.* directly in components.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  invoiceApi, productApi, partyApi, stockApi, tenantApi, aiApi,
  supplierApi, purchaseOrderApi, grnApi, stockAdjustmentApi, stockTransferApi, stockSummaryApi,
  expenseApi, branchApi, analyticsApi, reportsApi, staffApi, usersApi, contractApi, advanceApi, approvalApi, discountRulesApi, } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

// ── Query keys ──────────────────────────────────────────────────────────────
// Centralised so invalidation is consistent across the app

export const QK = {
  analyticsDashboard:    (params?: unknown) => ['analytics-dashboard', params],
  analyticsMargin:       (params?: unknown) => ['analytics-margin', params],
  analyticsTopCustomers: (params?: unknown) => ['analytics-top-customers', params],
  analyticsGstSummary:   (params?: unknown) => ['analytics-gst-summary', params],
  analyticsSalesVsPurchases: (params?: unknown) => ['analytics-sales-vs-purchases', params],
  reportsGstr1:          (params?: unknown) => ['reports-gstr1', params],
  reportsPl:             (params?: unknown) => ['reports-pl', params],
  reportsCashRegister:   (params?: unknown) => ['reports-cash-register', params],
  reportsBankAccounts:   ()                 => ['reports-bank-accounts'],
  reportsBankRecon:      (params?: unknown) => ['reports-bank-recon', params],
  reportsMonthly:        ()                 => ['reports-monthly'],
  staffUsers:            ()                 => ['staff-users'],
  staffAttendance:       (params?: unknown) => ['staff-attendance', params],
  staffShifts:           (params?: unknown) => ['staff-shifts', params],
  users:                 (params?: unknown) => ['users', params],
  invoices:        (params?: unknown) => ['invoices', params],
  invoice:         (id: string)       => ['invoice', id],
  dailySummary:    ()                 => ['daily-summary'],
  weeklySummary:   ()                 => ['weekly-summary'],
  products:        (params?: unknown) => ['products', params],
  product:         (id: string)       => ['product', id],
  lowStock:        ()                 => ['low-stock'],
  parties:         (params?: unknown) => ['parties', params],
  party:           (id: string)       => ['party', id],
  partyStatement:  (id: string)       => ['party-statement', id],
  udhaarSummary:   ()                 => ['udhaar-summary'],
  stock:           ()                 => ['stock'],
  gstinLookup:     (gstin: string)    => ['gstin', gstin],
  suppliers:       (params?: unknown) => ['suppliers', params],
  supplier:        (id: string)       => ['supplier', id],
  purchaseOrders:  (params?: unknown) => ['purchase-orders', params],
  purchaseOrder:   (id: string)       => ['purchase-order', id],
  grns:            (params?: unknown) => ['grns', params],
  adjustments:     (params?: unknown) => ['adjustments', params],
  adjustment:      (id: string)       => ['adjustment', id],
  transfers:       (params?: unknown) => ['transfers', params],
  transfer:        (id: string)       => ['transfer', id],
  stockLevels:     (params?: unknown) => ['stock-levels', params],
  stockLedger:     (id: string)       => ['stock-ledger', id],
  expenses:        (params?: unknown) => ['expenses', params],
  expenseSummary:  (params?: unknown) => ['expense-summary', params],
  expenseCategories: ()               => ['expense-categories'],
} as const

// ── Invoice hooks ─────────────────────────────────────────────────────────────

export function useInvoices(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: QK.invoices(params),
    queryFn:  () => invoiceApi.list(params),
  })
}

export function useInvoice(id: string) {
  return useQuery({
    queryKey: QK.invoice(id),
    queryFn:  () => invoiceApi.get(id),
    enabled:  !!id,
  })
}

export function useDailySummary() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  return useQuery({
    queryKey:        QK.dailySummary(),
    queryFn:         invoiceApi.dailySummary,
    refetchInterval: 60_000,  // refresh every 60s — live dashboard
    enabled:         isLoggedIn,
  })
}

export function useWeeklySummary() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  return useQuery({
    queryKey:        QK.weeklySummary(),
    queryFn:         invoiceApi.weeklySummary,
    refetchInterval: 300_000, // refresh every 5 min
    enabled:         isLoggedIn,
  })
}

export function useGstinLookup(gstin: string) {
  return useQuery({
    queryKey: QK.gstinLookup(gstin),
    queryFn:  () => tenantApi.gstinLookup(gstin),
    enabled:  gstin.length === 15,
    retry:    false,
    staleTime: 60 * 60 * 1000, // 1 hour — GSTIN data rarely changes
  })
}

export function useCreateInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: invoiceApi.create,
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['daily-summary'] })
      qc.invalidateQueries({ queryKey: ['stock'] })
      qc.invalidateQueries({ queryKey: ['parties'] })
      toast.success('Invoice created')
    },
    onError: (err: any) => {
      const data = err?.response?.data
      const detail = data?.detail?.join(', ') ?? data?.formErrors?.join(', ') ?? err.message
      toast.error(`Invoice failed: ${detail}`)
    },
  })
}

export function useCancelInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => invoiceApi.cancel(id),
    onSuccess:  (_data, id) => {
      qc.invalidateQueries({ queryKey: QK.invoice(id) })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['stock'] })
      toast.success('Invoice cancelled')
    },
  })
}

export function useCreateReturn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: unknown }) => invoiceApi.createReturn(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: QK.invoice(id) })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['stock'] })
      toast.success('Sale return created')
    },
  })
}

export function useCreateDebitNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: unknown }) => invoiceApi.createDebitNote(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: QK.invoice(id) })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Debit note created')
    },
  })
}

export function useGenerateIrn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => invoiceApi.generateIrn(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: QK.invoice(id) })
      toast.success('IRN generated')
    },
  })
}

export function useGenerateEway() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => invoiceApi.generateEway(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: QK.invoice(id) })
      toast.success('E-Way Bill generated')
    },
  })
}

export function useRecordPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) =>
      invoiceApi.recordPayment(id, data),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: QK.invoice(id) })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['parties'] })
      qc.invalidateQueries({ queryKey: ['daily-summary'] })
      toast.success('Payment recorded')
    },
  })
}

// ── Product hooks ─────────────────────────────────────────────────────────────

export function useProducts(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: QK.products(params),
    queryFn:  () => productApi.list(params),
  })
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: QK.product(id),
    queryFn:  () => productApi.get(id),
    enabled:  !!id,
  })
}

export function useLowStock() {
  return useQuery({
    queryKey: QK.lowStock(),
    queryFn:  productApi.lowStock,
  })
}

export function useCreateProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: productApi.create,
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['stock'] })
      toast.success('Product added')
    },
  })
}

export function useUpdateProduct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) =>
      productApi.update(id, data),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: QK.product(id) })
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success('Product updated')
    },
  })
}

export function useStockAdjust() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, qty, reason }: { id: string; qty: number; reason: string }) =>
      productApi.adjustStock(id, qty, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['stock'] })
      toast.success('Stock adjusted')
    },
  })
}

// ── Party hooks ───────────────────────────────────────────────────────────────

export function useParties(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: QK.parties(params),
    queryFn:  () => partyApi.list(params),
  })
}

export function useParty(id: string) {
  return useQuery({
    queryKey: QK.party(id),
    queryFn:  () => partyApi.get(id),
    enabled:  !!id,
  })
}

export function usePartyStatement(id: string) {
  return useQuery({
    queryKey: QK.partyStatement(id),
    queryFn:  () => partyApi.statement(id),
    enabled:  !!id,
  })
}

export function useUdhaarSummary() {
  return useQuery({
    queryKey: QK.udhaarSummary(),
    queryFn:  partyApi.udhaarSummary,
  })
}

export function useCreateParty() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: partyApi.create,
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['parties'] })
      toast.success('Party added')
    },
  })
}

// ── Stock hook ────────────────────────────────────────────────────────────────

export function useStock() {
  return useQuery({
    queryKey: QK.stock(),
    queryFn:  stockApi.all,
  })
}

// ── AI hooks ──────────────────────────────────────────────────────────────────

export function useAIInsight() {
  return useQuery({
    queryKey: ['ai-insight'],
    queryFn:  aiApi.insight,
    staleTime: 5 * 60 * 1000, // refresh every 5 min
    retry: false,
  })
}

export function useReorderSuggestions() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  return useQuery({
    queryKey: ['ai-reorder'],
    queryFn:  aiApi.reorder,
    staleTime: 10 * 60 * 1000,
    retry: false,
    enabled: isLoggedIn,
  })
}

export function useCreditRisk(partyId: string | undefined) {
  return useQuery({
    queryKey: ['ai-credit-risk', partyId],
    queryFn:  () => aiApi.creditRisk(partyId!),
    enabled:  !!partyId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function useSuggestHSN() {
  return useMutation({
    mutationFn: (productId: string) => productApi.suggestHSN(productId),
    onError: () => toast.error('HSN suggestion failed'),
  })
}

export function useConfirmHSN() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, hsnCode, gstRate }: { id: string; hsnCode: string; gstRate: number }) =>
      productApi.confirmHSN(id, hsnCode, gstRate),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success('HSN code saved')
    },
  })
}

// ── Supplier hooks ────────────────────────────────────────────────────────────

export function useSuppliers(params?: Record<string, unknown>) {
  return useQuery({ queryKey: QK.suppliers(params), queryFn: () => supplierApi.list(params) })
}

export function useSupplier(id: string) {
  return useQuery({ queryKey: QK.supplier(id), queryFn: () => supplierApi.get(id), enabled: !!id })
}

export function useCreateSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: supplierApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['suppliers'] }); toast.success('Supplier added') },
  })
}

export function useUpdateSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => supplierApi.update(id, data),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: QK.supplier(id) })
      qc.invalidateQueries({ queryKey: ['suppliers'] })
      toast.success('Supplier updated')
    },
  })
}

export function useDeleteSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => supplierApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['suppliers'] }); toast.success('Supplier deleted') },
  })
}

// ── Purchase Order hooks ──────────────────────────────────────────────────────

export function usePurchaseOrders(params?: Record<string, unknown>) {
  return useQuery({ queryKey: QK.purchaseOrders(params), queryFn: () => purchaseOrderApi.list(params) })
}

export function usePurchaseOrder(id: string) {
  return useQuery({ queryKey: QK.purchaseOrder(id), queryFn: () => purchaseOrderApi.get(id), enabled: !!id })
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: purchaseOrderApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['purchase-orders'] }); toast.success('Purchase order created') },
  })
}

export function useUpdatePurchaseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => purchaseOrderApi.update(id, data),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: QK.purchaseOrder(id) })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      toast.success('Purchase order updated')
    },
  })
}

export function useCancelPurchaseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => purchaseOrderApi.cancel(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: QK.purchaseOrder(id) })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      toast.success('Purchase order cancelled')
    },
  })
}

export function useRecordPOPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: any) => purchaseOrderApi.recordPayment(id, data),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: QK.purchaseOrder(id) })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      qc.invalidateQueries({ queryKey: ['expenses'] })
      toast.success('Payment recorded & expense created')
    },
  })
}

// ── GRN hooks ─────────────────────────────────────────────────────────────────

export function useGRNs(params?: Record<string, unknown>) {
  return useQuery({ queryKey: QK.grns(params), queryFn: () => grnApi.list(params) })
}

export function useCreateGRN() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: grnApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      qc.invalidateQueries({ queryKey: ['stock-levels'] })
      toast.success('Goods receipt recorded')
    },
  })
}

// ── Stock Adjustment hooks ────────────────────────────────────────────────────

export function useStockAdjustments(params?: Record<string, unknown>) {
  return useQuery({ queryKey: QK.adjustments(params), queryFn: () => stockAdjustmentApi.list(params) })
}

export function useStockAdjustment(id: string) {
  return useQuery({ queryKey: QK.adjustment(id), queryFn: () => stockAdjustmentApi.get(id), enabled: !!id })
}

export function useCreateStockAdjustment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: stockAdjustmentApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['adjustments'] }); toast.success('Adjustment saved as draft') },
  })
}

export function usePostStockAdjustment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => stockAdjustmentApi.post(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adjustments'] })
      qc.invalidateQueries({ queryKey: ['stock-levels'] })
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success('Adjustment posted — stock updated')
    },
  })
}

// ── Stock Transfer hooks ──────────────────────────────────────────────────────

export function useStockTransfers(params?: Record<string, unknown>) {
  return useQuery({ queryKey: QK.transfers(params), queryFn: () => stockTransferApi.list(params) })
}

export function useStockTransfer(id: string) {
  return useQuery({ queryKey: QK.transfer(id), queryFn: () => stockTransferApi.get(id), enabled: !!id })
}

export function useCreateStockTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: stockTransferApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transfers'] }); toast.success('Transfer created') },
  })
}

export function useDispatchStockTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => stockTransferApi.dispatch(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: QK.transfer(id) })
      qc.invalidateQueries({ queryKey: ['transfers'] })
      qc.invalidateQueries({ queryKey: ['stock-levels'] })
      toast.success('Transfer dispatched')
    },
  })
}

export function useReceiveStockTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => stockTransferApi.receive(id, data),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: QK.transfer(id) })
      qc.invalidateQueries({ queryKey: ['transfers'] })
      qc.invalidateQueries({ queryKey: ['stock-levels'] })
      toast.success('Transfer received — stock updated')
    },
  })
}

// ── Stock Level hooks ─────────────────────────────────────────────────────────

export function useStockLevels(params?: Record<string, unknown>) {
  return useQuery({ queryKey: QK.stockLevels(params), queryFn: () => stockSummaryApi.list(params) })
}

export function useStockLedger(productId: string) {
  return useQuery({
    queryKey: QK.stockLedger(productId),
    queryFn:  () => stockSummaryApi.ledger(productId),
    enabled:  !!productId,
  })
}

export function useExpiryAlerts(days = 90) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  return useQuery({
    queryKey: ['expiry-alerts', days],
    queryFn:  () => stockSummaryApi.expiryAlerts(days),
    staleTime: 5 * 60 * 1000,
    enabled: isLoggedIn,
  })
}

// ── Branch hooks ─────────────────────────────────────────────────────────────

export function useBranches() {
  return useQuery({ queryKey: ['branches'], queryFn: branchApi.list })
}

export function useCreateBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: unknown) => branchApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] })
      toast.success('Branch created')
    },
  })
}

export function useUpdateBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: any) => branchApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] })
      toast.success('Branch updated')
    },
  })
}

export function useDeactivateBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => branchApi.deactivate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] })
      toast.success('Branch deactivated')
    },
  })
}

export function useActivateBranch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => branchApi.activate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] })
      toast.success('Branch activated')
    },
  })
}

// ── Expense hooks ─────────────────────────────────────────────────────────────

export function useExpenses(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: QK.expenses(params),
    queryFn:  () => expenseApi.list(params),
  })
}

export function useExpenseSummary(params?: { from?: string; to?: string; branchId?: string }) {
  return useQuery({
    queryKey: QK.expenseSummary(params),
    queryFn:  () => expenseApi.summary(params),
  })
}

export function useExpenseCategories() {
  return useQuery({
    queryKey: QK.expenseCategories(),
    queryFn:  expenseApi.categories,
    staleTime: Infinity, // categories don't change at runtime
  })
}

export function useCreateExpense() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: expenseApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['expense-summary'] })
      toast.success('Expense added')
    },
  })
}

export function useUpdateExpense() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) =>
      expenseApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['expense-summary'] })
      toast.success('Expense updated')
    },
  })
}

export function useDeleteExpense() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => expenseApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['expense-summary'] })
      toast.success('Expense deleted')
    },
  })
}

// ── Analytics hooks ───────────────────────────────────────────────────────────

export function useAnalyticsDashboard(params?: { period?: string; compareWith?: string }) {
  return useQuery({
    queryKey: QK.analyticsDashboard(params),
    queryFn:  () => analyticsApi.dashboard(params),
  })
}

export function useAnalyticsMargin(params?: { period?: string }) {
  return useQuery({
    queryKey: QK.analyticsMargin(params),
    queryFn:  () => analyticsApi.marginReport(params),
  })
}

export function useAnalyticsTopCustomers(params?: { period?: string; limit?: number }) {
  return useQuery({
    queryKey: QK.analyticsTopCustomers(params),
    queryFn:  () => analyticsApi.topCustomers(params),
  })
}

export function useAnalyticsGstSummary(params?: { month?: string }) {
  return useQuery({
    queryKey: QK.analyticsGstSummary(params),
    queryFn:  () => analyticsApi.gstSummary(params),
    enabled:  !!params?.month,
  })
}

export function useAnalyticsSalesVsPurchases(params?: { months?: number }) {
  return useQuery({
    queryKey: QK.analyticsSalesVsPurchases(params),
    queryFn:  () => analyticsApi.salesVsPurchases(params),
  })
}

export function useReportsGstr1(params?: { month?: string }) {
  return useQuery({
    queryKey: QK.reportsGstr1(params),
    queryFn:  () => reportsApi.gstr1(params),
    enabled:  !!params?.month,
  })
}

export function useReportsPlStatement(params?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: QK.reportsPl(params),
    queryFn:  () => reportsApi.plStatement(params),
    enabled:  !!params?.from && !!params?.to,
  })
}

export function useReportsCashRegister(params?: { date?: string }) {
  return useQuery({
    queryKey: QK.reportsCashRegister(params),
    queryFn:  () => reportsApi.cashRegisterGet(params),
  })
}

export function useReportsCashRegisterSave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: reportsApi.cashRegisterSave,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports-cash-register'] })
      toast.success('Cash count saved')
    },
    onError: () => toast.error('Failed to save cash count'),
  })
}

export function useReportsBankAccounts() {
  return useQuery({
    queryKey: QK.reportsBankAccounts(),
    queryFn:  () => reportsApi.bankAccounts(),
  })
}

export function useReportsBankAccountCreate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: reportsApi.bankAccountCreate,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.reportsBankAccounts() })
      toast.success('Bank account added')
    },
    onError: () => toast.error('Failed to add bank account'),
  })
}

export function useReportsBankRecon(params: { month: string; bankAccountId?: string }) {
  return useQuery({
    queryKey: QK.reportsBankRecon(params),
    queryFn:  () => reportsApi.bankReconGet(params),
    enabled:  !!params.month,
  })
}

export function useReportsBankReconSave() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: reportsApi.bankReconSave,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports-bank-recon'] })
      toast.success('Reconciliation saved')
    },
    onError: () => toast.error('Failed to save reconciliation'),
  })
}

export function useMonthlyComparison() {
  return useQuery({
    queryKey: QK.reportsMonthly(),
    queryFn:  () => reportsApi.monthlyComparison(),
    staleTime: 5 * 60 * 1000,
  })
}

export function useDayBook(params?: { date?: string }) {
  return useQuery({
    queryKey: ['reports-day-book', params],
    queryFn:  () => reportsApi.dayBook(params),
    staleTime: 60 * 1000,
  })
}

// ── Staff ─────────────────────────────────────────────────────────────────────

export function useStaffUsers() {
  return useQuery({
    queryKey: QK.staffUsers(),
    queryFn:  () => staffApi.users(),
  })
}

export function useStaffAttendance(params: { date?: string; month?: string; userId?: string }) {
  return useQuery({
    queryKey: QK.staffAttendance(params),
    queryFn:  () => staffApi.getAttendance(params),
  })
}

export function useRecordAttendance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: staffApi.recordAttendance,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff-attendance'] })
      toast.success('Attendance saved')
    },
    onError: () => toast.error('Failed to save attendance'),
  })
}

export function useUpdateAttendance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { clockOut?: string; status?: string; notes?: string } }) =>
      staffApi.updateAttendance(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff-attendance'] })
      toast.success('Updated')
    },
    onError: () => toast.error('Update failed'),
  })
}

export function useStaffShifts(params: { from?: string; to?: string; userId?: string }) {
  return useQuery({
    queryKey: QK.staffShifts(params),
    queryFn:  () => staffApi.getShifts(params),
  })
}

export function useCreateShift() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: staffApi.createShift,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff-shifts'] })
      toast.success('Shift scheduled')
    },
    onError: () => toast.error('Failed to schedule shift'),
  })
}

export function useDeleteShift() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: staffApi.deleteShift,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff-shifts'] })
    },
    onError: () => toast.error('Failed to delete shift'),
  })
}

// ── Invoice send-receipt ──────────────────────────────────────────────────────

export function useSendReceipt() {
  return useMutation({
    mutationFn: ({ id, data }: {
      id: string
      data: { channel: 'whatsapp' | 'email'; to?: string; businessName?: string }
    }) => invoiceApi.sendReceipt(id, data),
    onSuccess: (_, vars) => {
      toast.success(vars.data.channel === 'whatsapp' ? 'Receipt sent via WhatsApp' : 'Receipt sent via email')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error ?? 'Failed to send receipt'
      toast.error(msg)
    },
  })
}

// ── User management ───────────────────────────────────────────────────────────

export function useUsers(params?: { role?: string; isActive?: boolean; search?: string }) {
  return useQuery({
    queryKey: QK.users(params),
    queryFn:  () => usersApi.list(params),
  })
}

export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; phone: string; pin: string; role?: string; branchIds?: string[]; lang?: string }) =>
      usersApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      toast.success('User created successfully')
    },
    onError: (err: any) => toast.error(err?.response?.data?.error ?? 'Failed to create user'),
  })
}

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; role?: string; branchIds?: string[]; lang?: string } }) =>
      usersApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      toast.success('User updated')
    },
    onError: (err: any) => toast.error(err?.response?.data?.error ?? 'Failed to update user'),
  })
}

export function useResetUserPin() {
  return useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: string }) => usersApi.resetPin(id, pin),
    onSuccess: () => toast.success('PIN reset successfully'),
    onError: (err: any) => toast.error(err?.response?.data?.error ?? 'Failed to reset PIN'),
  })
}

export function useDeactivateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => usersApi.deactivate(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast.success('User deactivated') },
    onError: (err: any) => toast.error(err?.response?.data?.error ?? 'Failed to deactivate user'),
  })
}

export function useActivateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => usersApi.activate(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast.success('User activated') },
    onError: (err: any) => toast.error(err?.response?.data?.error ?? 'Failed to activate user'),
  })
}

// ── Contracts ─────────────────────────────────────────────────────────────────

export function useContracts(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: ['contracts', params],
    queryFn:  () => contractApi.list(params),
  })
}

export function useContract(id: string) {
  return useQuery({
    queryKey: ['contract', id],
    queryFn:  () => contractApi.get(id),
    enabled:  !!id,
  })
}

export function useCreateContract() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: contractApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contracts'] }); toast.success('Contract created') },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed'),
  })
}

export function useUpdateContract() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) => contractApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contracts'] }); toast.success('Contract updated') },
  })
}

export function useGenerateContractInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => contractApi.generateInvoice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contracts'] })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Invoice generated')
    },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed'),
  })
}

// ── Advances ──────────────────────────────────────────────────────────────────

export function useAdvances(params?: Record<string, unknown>) {
  return useQuery({
    queryKey: ['advances', params],
    queryFn:  () => advanceApi.list(params),
  })
}

export function useRecordAdvance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: advanceApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['advances'] }); toast.success('Advance recorded') },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed'),
  })
}

export function useAllocateAdvance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, allocations }: { id: string; allocations: Array<{ invoiceId: string; amount: number }> }) =>
      advanceApi.allocate(id, allocations),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['advances'] })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Advance allocated')
    },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Failed'),
  })
}

// ── Approvals ─────────────────────────────────────────────────────────────────

export function usePendingApprovals({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['pending-approvals'],
    queryFn:  () => approvalApi.pending().then((r: any) => (Array.isArray(r) ? r : r?.data ?? [])),
    refetchInterval: enabled ? 30_000 : false,
    enabled,
  })
}

export function useApproveInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalApi.approve(id, note),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ['pending-approvals'] })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['invoice', id] })
      toast.success('Invoice approved')
    },
  })
}

export function useRejectInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => approvalApi.reject(id, note),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ['pending-approvals'] })
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['invoice', id] })
      toast.success('Invoice rejected')
    },
  })
}

export function useRequestApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => approvalApi.requestApproval(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['invoice', id] })
      toast.success('Sent for approval')
    },
  })
}

export function useConvertInvoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, targetType }: { id: string; targetType?: string }) =>
      approvalApi.convert(id, targetType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Document converted')
    },
    onError: (e: any) => toast.error(e?.response?.data?.error ?? 'Conversion failed'),
  })
}

export function useDiscountRules() {
  return useQuery({
    queryKey: ['discount-rules'],
    queryFn:  () => discountRulesApi.list({ active: true }),
    staleTime: 60_000,
  })
}

export function useCreateDiscountRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: any) => discountRulesApi.create(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discount-rules'] }); toast.success('Rule created') },
    onError:   (e: any) => toast.error(e?.response?.data?.error ?? 'Failed to create rule'),
  })
}

export function useUpdateDiscountRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: any) => discountRulesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discount-rules'] }); toast.success('Rule updated') },
    onError:   (e: any) => toast.error(e?.response?.data?.error ?? 'Failed to update rule'),
  })
}

export function useDeleteDiscountRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => discountRulesApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discount-rules'] }); toast.success('Rule deleted') },
    onError:   (e: any) => toast.error(e?.response?.data?.error ?? 'Failed to delete rule'),
  })
}
