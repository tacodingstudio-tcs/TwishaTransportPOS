// src/components/layout/AppLayout.tsx
import { useState } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/auth.store'
import { authApi } from '@/lib/api'
import {
  LayoutDashboard, FileText, Warehouse, Users, LogOut, Plus, Sparkles, BarChart2, Building2, ShoppingCart,
  ClipboardCheck, ArrowLeftRight, Package, ChevronDown, TrendingDown, UserCheck, GitBranch, Clock,
  RefreshCw, Wallet, TrendingUp, MessageCircle, Truck, Route, ReceiptText, ShieldAlert, Contact,
  MapPinned, Fuel, LineChart, Container, Rows3,
} from 'lucide-react'
import { usePendingApprovals } from '@/hooks/useApi'
import { CelebrationsPanel } from '@/components/CelebrationsPanel'

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
  { to: '/reports',            label: 'GST Reports',  icon: BarChart2 },
  { to: '/analytics',          label: 'Charts',       icon: Container },
]

const OTHER: NavItem[] = [
  { to: '/pipeline',  label: 'Rate Quotes', icon: GitBranch },
  { to: '/contracts', label: 'Contracts',  icon: RefreshCw },
  { to: '/broadcast', label: 'Broadcast',  icon: MessageCircle },
  { to: '/staff',     label: 'Staff',      icon: UserCheck },
  { to: '/ai',        label: 'AI Assistant', icon: Sparkles },
  { to: '/branches',  label: 'My Business & Staff', icon: Building2 },
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

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, tenant, branch, refreshToken, logout, canManage } = useAuthStore()
  const inventoryOpen = location.pathname.startsWith('/inventory')
  const [moreOpen, setMoreOpen] = useState(() => OTHER.some((i) => location.pathname.startsWith(i.to)))

  const isManager = canManage()
  const { data: pendingApprovals } = usePendingApprovals({ enabled: isManager })
  const pendingCount = Array.isArray(pendingApprovals) ? pendingApprovals.length : 0

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

        {/* Logo / business name */}
        <div className="h-16 flex items-center gap-2 px-5 border-b border-gray-200">
          <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center">
            <Truck className="w-4 h-4 text-white" />
          </div>
          <div className="overflow-hidden">
            <div className="text-sm font-semibold text-gray-900 truncate">{tenant?.name ?? 'HisabKitab Transport'}</div>
            <div className="text-xs text-gray-500 truncate">{branch?.name}</div>
          </div>
        </div>

        {/* Quick create — hidden for read-only users */}
        {user?.role !== 'viewer' ? (
          <div className="p-3">
            <NavLink to="/transport/lrs/new" className="btn-primary w-full justify-center">
              <Plus className="w-4 h-4" /> New Load (LR)
            </NavLink>
          </div>
        ) : <div className="h-3" />}

        {/* Navigation */}
        <nav className="flex-1 px-3 pb-3 space-y-1 overflow-y-auto">
          <Section items={OPERATIONS} />
          <Section title="Trucks & drivers" items={FLEET} />
          <Section title="Money" items={FINANCE} />

          {isManager && (
            <div className="space-y-1">
              <NavLink to="/aging" className={linkCls}>
                <TrendingUp className="w-4 h-4" /><span className="flex-1">Pending Money</span>
              </NavLink>
              <NavLink to="/advances" className={linkCls}>
                <Wallet className="w-4 h-4" /><span className="flex-1">Advances</span>
              </NavLink>
              <NavLink to="/approvals" className={linkCls}>
                <Clock className="w-4 h-4" />
                <span className="flex-1">Approvals</span>
                {pendingCount > 0 && (
                  <span className="ml-auto bg-yellow-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {pendingCount}
                  </span>
                )}
              </NavLink>
            </div>
          )}

          {/* Inventory — expandable (tyres, spares, lubricants) */}
          <NavLink to="/inventory"
            className={() =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                inventoryOpen ? 'bg-primary-50 text-primary-700' : 'text-gray-600 hover:bg-gray-100'
              }`}>
            <Warehouse className="w-4 h-4" />
            <span className="flex-1">Stores</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${inventoryOpen ? 'rotate-180' : ''}`} />
          </NavLink>
          {inventoryOpen && (
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
          {moreOpen && <Section items={OTHER} />}
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
        <div className="h-12 flex items-center justify-end gap-1 px-4 border-b border-gray-100 bg-white shrink-0">
          <CelebrationsPanel businessName={branch?.name ?? tenant?.name ?? 'Our Business'} />
        </div>
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
