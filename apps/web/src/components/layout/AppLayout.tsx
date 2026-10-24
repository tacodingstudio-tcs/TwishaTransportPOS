// src/components/layout/AppLayout.tsx
import { useEffect, useState } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/auth.store'
import { authApi } from '@/lib/api'
import {
  LayoutDashboard, FileText, Warehouse, Users, LogOut, Plus, BarChart2, Building2, ShoppingCart,
  ClipboardCheck, ArrowLeftRight, Package, ChevronDown, TrendingDown, GitBranch, Clock,
  RefreshCw, Wallet, TrendingUp, MessageCircle, Truck, Route, ReceiptText, ShieldAlert, Contact,
  MapPinned, Fuel, LineChart, Rows3, Landmark, FileSpreadsheet,
} from 'lucide-react'
import { PoweredByCompact } from '@/components/PoweredBy'
import { FirmSwitcher, FirmMenu } from '@/components/layout/FirmSwitcher'
import { useCurrentFirm } from '@/hooks/useFirms'

/** The Stores menu (stock, suppliers, purchase orders…) came with the shared core and is unused by transport. */
const SHOW_STORES = false

type NavItem = { to: string; label: string; icon: React.ElementType; end?: boolean }

// ── Transport navigation (this product is single-domain) ────────────────────
const OPERATIONS: NavItem[] = [
  { to: '/',                  label: 'Home',            icon: LayoutDashboard, end: true },
  { to: '/transport/lrs',     label: 'Loads (LR)',      icon: FileText },
  { to: '/transport/lrs/quick', label: 'Enter Many Loads', icon: Rows3 },
  { to: '/transport/trips',   label: 'Truck Trips',     icon: Route },
  { to: '/transport/billing', label: 'Make Bill',       icon: ReceiptText },
  { to: '/invoices',          label: 'All Bills',       icon: FileText },
  { to: '/parties',           label: 'Parties',         icon: Users },
]

const FLEET: NavItem[] = [
  { to: '/transport/vehicles',   label: 'Trucks',     icon: Truck },
  { to: '/transport/drivers',    label: 'Drivers',    icon: Contact },
  { to: '/transport/compliance', label: 'Papers Expiry', icon: ShieldAlert },
  { to: '/transport/routes',     label: 'Rates',      icon: MapPinned },
]

const FINANCE: NavItem[] = [
  { to: '/transport/expenses', label: 'Diesel & Trip Costs', icon: Fuel },
  { to: '/expenses',           label: 'Office Costs',  icon: TrendingDown },
  { to: '/transport/reports',  label: 'Profit Report', icon: LineChart },
  { to: '/transport/bank',     label: 'Bank Statements', icon: Landmark },
  { to: '/transport/ca',       label: 'CA Reports',   icon: FileSpreadsheet },
  { to: '/reports',            label: 'GST Reports',  icon: BarChart2 },
]

const OTHER: NavItem[] = [
  { to: '/transport/messages', label: 'WhatsApp Messages', icon: MessageCircle },
  { to: '/branches',  label: 'Firms & Staff', icon: Building2 },
]

// ── A goods / trading firm (e.g. the firm that sells the fly ash) only needs billing — no trucks, trips or LRs ──
const OPERATIONS_GOODS: NavItem[] = [
  { to: '/',                           label: 'Home',       icon: LayoutDashboard, end: true },
  { to: '/transport/goods-bills/new',  label: 'Goods Bill', icon: ReceiptText },
  { to: '/invoices',                   label: 'All Bills',  icon: FileText },
  { to: '/parties',                    label: 'Customers',  icon: Users },
]
const FINANCE_GOODS: NavItem[] = [
  { to: '/expenses',  label: 'Office Costs', icon: TrendingDown },
  { to: '/transport/bank', label: 'Bank Statements', icon: Landmark },
  { to: '/transport/ca',   label: 'CA Reports',      icon: FileSpreadsheet },
  { to: '/reports',   label: 'GST Reports',  icon: BarChart2 },
]
const OTHER_GOODS: NavItem[] = [
  { to: '/branches',  label: 'Firms & Staff', icon: Building2 },
]

const INVENTORY_ITEMS = [
  { to: '/inventory/stock',           label: 'Stock Levels',    icon: BarChart2 },
  { to: '/inventory/products',        label: 'Services & Spares', icon: Package },
  { to: '/inventory/suppliers',       label: 'Suppliers',       icon: Building2 },
  { to: '/inventory/purchase-orders', label: 'Purchase Orders', icon: ShoppingCart },
  { to: '/inventory/adjustments',     label: 'Adjustments',     icon: ClipboardCheck },
  { to: '/inventory/transfers',       label: 'Transfers',       icon: ArrowLeftRight },
  { to: '/inventory/grn',             label: 'Goods Receipts',  icon: Package },
]

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    isActive ? 'bg-primary-50 text-primary-700' : 'text-gray-600 hover:bg-gray-100'
  }`

function Section({ title, items }: { title?: string; items: NavItem[] }) {
  return (
    <div className="space-y-1">
      {title && <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</div>}
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className={linkCls}>
          <Icon className="w-4 h-4" />
          <span className="flex-1">{label}</span>
        </NavLink>
      ))}
    </div>
  )
}

/**
 * Screens are downloaded when first opened. Shortly after sign-in, while the browser is idle, fetch the busiest ones too, so the
 * first click on them is instant. (import() of the same module is shared with the lazy routes — nothing is downloaded twice.)
 */
function prefetchBusyScreens() {
  const go = () => {
    void import('@/pages/transport/LorryReceiptsPage'); void import('@/pages/transport/LrFormPage'); void import('@/pages/transport/TripsPage')
    void import('@/pages/transport/FreightBillingPage'); void import('@/pages/InvoiceListPage'); void import('@/pages/InvoiceDetailPage')
    void import('@/pages/PartyListPage'); void import('@/pages/transport/TransportExpensesPage'); void import('@/pages/ExpensePage')
  }
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 5000 }); else setTimeout(go, 2500)
}

export function AppLayout() {
  useEffect(() => { prefetchBusyScreens() }, [])
  const navigate = useNavigate()
  const location = useLocation()
  const { user, tenant, branch, refreshToken, logout, canManage } = useAuthStore()
  const { firm, firms, tone } = useCurrentFirm()
  // Until the firm list arrives, trust the branch saved at sign-in so the menu never flashes the wrong set.
  const isGoods = (firm?.kind ?? (branch?.domainConfig as any)?.firm_kind) === 'goods'
  const inventoryOpen = location.pathname.startsWith('/inventory')
  const otherItems = isGoods ? OTHER_GOODS : OTHER
  const [moreOpen, setMoreOpen] = useState(() => OTHER.some((i) => location.pathname.startsWith(i.to)) || OTHER_GOODS.some((i) => location.pathname.startsWith(i.to)))

  const isManager = canManage()

  async function handleLogout() {
    // Revoke the refresh token server-side BEFORE clearing local state —
    // otherwise the session technically stays valid server-side until its
    // 30-day expiry. Best-effort: if the call fails, still clear local state.
    if (refreshToken) await authApi.logout(refreshToken).catch(() => {})
    logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-gray-50">

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="w-60 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">

        {/* Firm: which business name you are working as, and a one-tap switch */}
        <FirmSwitcher />

        {/* Quick create — hidden for read-only users */}
        {user?.role !== 'viewer' ? (
          <div className="p-3">
            {isGoods ? (
              <NavLink to="/transport/goods-bills/new" className="btn-primary w-full justify-center">
                <Plus className="w-4 h-4" /> New Goods Bill
              </NavLink>
            ) : (
              <NavLink to="/transport/lrs/new" className="btn-primary w-full justify-center">
                <Plus className="w-4 h-4" /> New Load (LR)
              </NavLink>
            )}
          </div>
        ) : <div className="h-3" />}

        {/* Navigation */}
        <nav className="flex-1 px-3 pb-3 space-y-1 overflow-y-auto">
          <Section items={isGoods ? OPERATIONS_GOODS : OPERATIONS} />
          {!isGoods && <Section title="Trucks & drivers" items={FLEET} />}
          <Section title="Money" items={isGoods ? FINANCE_GOODS : FINANCE} />

          {isManager && (
            <div className="space-y-1">
              <NavLink to="/aging" className={linkCls}>
                <TrendingUp className="w-4 h-4" /><span className="flex-1">Pending Money</span>
              </NavLink>
              <NavLink to="/advances" className={linkCls}>
                <Wallet className="w-4 h-4" /><span className="flex-1">Advances</span>
              </NavLink>
            </div>
          )}

          {/* Stores (tyres, spares, lubricants) — hidden: nothing in the transport flow uses stock yet. Flip SHOW_STORES to bring it back. */}
          {SHOW_STORES && !isGoods && <NavLink to="/inventory"
            className={() =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                inventoryOpen ? 'bg-primary-50 text-primary-700' : 'text-gray-600 hover:bg-gray-100'
              }`}>
            <Warehouse className="w-4 h-4" />
            <span className="flex-1">Stores</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${inventoryOpen ? 'rotate-180' : ''}`} />
          </NavLink>}
          {SHOW_STORES && !isGoods && inventoryOpen && (
            <div className="ml-4 pl-3 border-l border-gray-200 space-y-0.5">
              {INVENTORY_ITEMS.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      isActive ? 'bg-primary-50 text-primary-700' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                    }`}>
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </NavLink>
              ))}
            </div>
          )}

          {/* Rarely used screens stay folded so the menu is short and calm */}
          <button type="button" onClick={() => setMoreOpen((v) => !v)}
            className="w-full flex items-center gap-3 px-3 py-2 mt-2 rounded-lg text-xs font-semibold uppercase tracking-wider text-gray-400 hover:bg-gray-100">
            <span className="flex-1 text-left">More</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
          {moreOpen && <Section items={otherItems} />}
        </nav>

        {/* User footer */}
        <div className="p-3 border-t border-gray-200">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-semibold text-gray-600">
              {user?.name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="text-sm font-medium text-gray-900 truncate">{user?.name}</div>
              <div className="text-xs text-gray-500 capitalize">{user?.role}</div>
            </div>
            <button type="button" onClick={handleLogout} title="Logout"
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        <div className="h-12 flex items-center gap-1 px-4 border-b border-gray-100 bg-white shrink-0">
          {/* With more than one firm, keep the active one in view so nobody bills under the wrong name */}
          <FirmMenu />
          <span className="flex-1" />
          <PoweredByCompact />
        </div>
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
