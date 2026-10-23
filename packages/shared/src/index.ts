// packages/shared/src/index.ts

// ── GST ──────────────────────────────────────────────────────────────────────
export const GST_RATES = [0, 5, 12, 18, 28] as const
export type GSTRate = typeof GST_RATES[number]

export { INDIAN_STATE_CODES } from './states.js'

// ── Transaction types ─────────────────────────────────────────────────────────
export const TXN_TYPES = [
  'sale_invoice', 'purchase_invoice',
  'sale_return',  'purchase_return',
  'quotation',    'delivery_challan',
] as const
export type TxnType = typeof TXN_TYPES[number]

// ── Invoice statuses ──────────────────────────────────────────────────────────
export const INVOICE_STATUSES = ['draft','confirmed','paid','partial','cancelled'] as const
export type InvoiceStatus = typeof INVOICE_STATUSES[number]

// ── Payment methods ───────────────────────────────────────────────────────────
export const PAYMENT_METHODS = ['cash','upi','card','cheque','bank_transfer','credit'] as const
export type PaymentMethod = typeof PAYMENT_METHODS[number]

// ── User roles ────────────────────────────────────────────────────────────────
export const USER_ROLES = ['owner','manager','cashier','viewer'] as const
export type UserRole = typeof USER_ROLES[number]

// ── Domain types ──────────────────────────────────────────────────────────────
export const DOMAIN_TYPES = ['retail','restaurant','pharmacy','salon','wholesale','sweet'] as const
export type DomainType = typeof DOMAIN_TYPES[number]

// ── Utility: check if a transaction is a sale ─────────────────────────────────
export function isSaleTxn(txnType: string): boolean {
  return ['sale_invoice', 'quotation', 'delivery_challan'].includes(txnType)
}

// ── Utility: format currency for display ─────────────────────────────────────
export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style:    'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount)
}

// ── Utility: current Indian financial year ────────────────────────────────────
export function currentFY(): string {
  const now  = new Date()
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  return `${year}-${String(year + 1).slice(-2)}`  // "2025-26"
}

// ── Printed tax invoice (shared by the print page and the server PDF) ────────────
export * from './tax-invoice.js'
export * from './bank-statement.js'
