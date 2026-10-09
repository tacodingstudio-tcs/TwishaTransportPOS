// Values shared by the transport route files.
import { getExpenseCategories } from '@billing/domain-registry'

/** Every expense category code valid for a transport branch (domain-specific + universal). */
export const EXPENSE_CATEGORY_CODES = getExpenseCategories('transport').map((c) => c.code) as [string, ...string[]]
