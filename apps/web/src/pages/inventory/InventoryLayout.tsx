// src/pages/inventory/InventoryLayout.tsx
import { NavLink, Outlet } from 'react-router-dom'
import { BarChart2, ShoppingCart, ClipboardCheck, ArrowLeftRight, Package } from 'lucide-react'

const tabs = [
  { to: '/inventory/stock',           label: 'Stock Levels',    icon: BarChart2 },
  { to: '/inventory/products',        label: 'Products',        icon: Package },
  { to: '/inventory/purchase-orders', label: 'Purchase Orders', icon: ShoppingCart },
  { to: '/inventory/adjustments',     label: 'Adjustments',     icon: ClipboardCheck },
  { to: '/inventory/transfers',       label: 'Transfers',       icon: ArrowLeftRight },
]

export function InventoryLayout() {
  return (
    <div className="flex flex-col h-full">
      {/* Sub-nav tab bar */}
      <div className="bg-white border-b border-gray-200 px-8">
        <nav className="flex gap-1 -mb-px">
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-primary-600 text-primary-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  )
}
