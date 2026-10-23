// src/App.tsx
import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth.store'
const AppLayout = lazy(() => import('./components/layout/AppLayout').then((m) => ({ default: m.AppLayout })))
import { LoginPage } from './pages/LoginPage'
const InvoiceListPage = lazy(() => import('./pages/InvoiceListPage').then((m) => ({ default: m.InvoiceListPage })))
const CreateInvoicePage = lazy(() => import('./pages/CreateInvoicePage').then((m) => ({ default: m.CreateInvoicePage })))
const InvoiceDetailPage = lazy(() => import('./pages/InvoiceDetailPage').then((m) => ({ default: m.InvoiceDetailPage })))
const ProductListPage = lazy(() => import('./pages/ProductListPage').then((m) => ({ default: m.ProductListPage })))
const PartyListPage = lazy(() => import('./pages/PartyListPage').then((m) => ({ default: m.PartyListPage })))
const PartyStatementPage = lazy(() => import('./pages/PartyStatementPage').then((m) => ({ default: m.PartyStatementPage })))
const InventoryLayout = lazy(() => import('./pages/inventory/InventoryLayout').then((m) => ({ default: m.InventoryLayout })))
const StockLevelsPage = lazy(() => import('./pages/inventory/StockLevelsPage').then((m) => ({ default: m.StockLevelsPage })))
const SuppliersPage = lazy(() => import('./pages/inventory/SuppliersPage').then((m) => ({ default: m.SuppliersPage })))
const PurchaseOrdersPage = lazy(() => import('./pages/inventory/PurchaseOrdersPage').then((m) => ({ default: m.PurchaseOrdersPage })))
const PurchaseOrderDetailPage = lazy(() => import('./pages/inventory/PurchaseOrderDetailPage').then((m) => ({ default: m.PurchaseOrderDetailPage })))
const StockAdjustmentPage = lazy(() => import('./pages/inventory/StockAdjustmentPage').then((m) => ({ default: m.StockAdjustmentPage })))
const StockTransfersPage = lazy(() => import('./pages/inventory/StockTransfersPage').then((m) => ({ default: m.StockTransfersPage })))
const ExpensePage = lazy(() => import('./pages/ExpensePage').then((m) => ({ default: m.ExpensePage })))
const BranchesPage = lazy(() => import('./pages/BranchesPage').then((m) => ({ default: m.BranchesPage })))
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const AdvancesPage = lazy(() => import('./pages/AdvancesPage'))
const GRNPage = lazy(() => import('./pages/inventory/GRNPage'))
const AgingPage = lazy(() => import('./pages/AgingPage'))

// Transport
const TransportDashboardPage = lazy(() => import('./pages/transport/TransportDashboardPage').then((m) => ({ default: m.TransportDashboardPage })))
const LorryReceiptsPage = lazy(() => import('./pages/transport/LorryReceiptsPage').then((m) => ({ default: m.LorryReceiptsPage })))
const LrFormPage = lazy(() => import('./pages/transport/LrFormPage').then((m) => ({ default: m.LrFormPage })))
const QuickEntryPage = lazy(() => import('./pages/transport/QuickEntryPage').then((m) => ({ default: m.QuickEntryPage })))
const FreightBillPrintPage = lazy(() => import('./pages/transport/FreightBillPrintPage').then((m) => ({ default: m.FreightBillPrintPage })))
const TaxInvoicePrintPage = lazy(() => import('./pages/transport/TaxInvoicePrintPage').then((m) => ({ default: m.TaxInvoicePrintPage })))
const GoodsBillPage = lazy(() => import('./pages/transport/GoodsBillPage').then((m) => ({ default: m.GoodsBillPage })))
const BankPage = lazy(() => import('./pages/transport/BankPage').then((m) => ({ default: m.BankPage })))
const CaReportsPage = lazy(() => import('./pages/transport/CaReportsPage').then((m) => ({ default: m.CaReportsPage })))
const HomeRoute = lazy(() => import('./pages/transport/HomeRoute').then((m) => ({ default: m.HomeRoute })))
const LrDetailPage = lazy(() => import('./pages/transport/LrDetailPage').then((m) => ({ default: m.LrDetailPage })))
const LrPrintPage = lazy(() => import('./pages/transport/LrPrintPage').then((m) => ({ default: m.LrPrintPage })))
const TripsPage = lazy(() => import('./pages/transport/TripsPage').then((m) => ({ default: m.TripsPage })))
const TripDetailPage = lazy(() => import('./pages/transport/TripDetailPage').then((m) => ({ default: m.TripDetailPage })))
const FreightBillingPage = lazy(() => import('./pages/transport/FreightBillingPage').then((m) => ({ default: m.FreightBillingPage })))
const VehiclesPage = lazy(() => import('./pages/transport/VehiclesPage').then((m) => ({ default: m.VehiclesPage })))
const VehicleDetailPage = lazy(() => import('./pages/transport/VehicleDetailPage').then((m) => ({ default: m.VehicleDetailPage })))
const DriversPage = lazy(() => import('./pages/transport/DriversPage').then((m) => ({ default: m.DriversPage })))
const RoutesPage = lazy(() => import('./pages/transport/RoutesPage').then((m) => ({ default: m.RoutesPage })))
const CompliancePage = lazy(() => import('./pages/transport/CompliancePage').then((m) => ({ default: m.CompliancePage })))
const TransportExpensesPage = lazy(() => import('./pages/transport/TransportExpensesPage').then((m) => ({ default: m.TransportExpensesPage })))
const TransportReportsPage = lazy(() => import('./pages/transport/TransportReportsPage').then((m) => ({ default: m.TransportReportsPage })))
const MessagesPage = lazy(() => import('./pages/transport/MessagesPage').then((m) => ({ default: m.MessagesPage })))

// A screen's code downloads the first time it is opened (everyone used to download every screen up front).
function ScreenLoading() {
  return <div className="p-10 text-center text-sm text-gray-400" role="status">Loading…</div>
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  if (!isLoggedIn) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<ScreenLoading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Printable consignment note — outside the app shell so only the document prints */}
        <Route path="/transport/lrs/:id/print" element={<ProtectedRoute><LrPrintPage /></ProtectedRoute>} />
        <Route path="/transport/bills/:id/print" element={<ProtectedRoute><FreightBillPrintPage /></ProtectedRoute>} />
        <Route path="/transport/invoice/:id/print" element={<ProtectedRoute><TaxInvoicePrintPage /></ProtectedRoute>} />

        <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
          <Route path="/" element={<HomeRoute />} />

          {/* ── Transport operations ── */}
          <Route path="/transport/lrs"            element={<LorryReceiptsPage />} />
          <Route path="/transport/lrs/new"        element={<LrFormPage />} />
          <Route path="/transport/lrs/quick"      element={<QuickEntryPage />} />
          <Route path="/transport/lrs/:id"        element={<LrDetailPage />} />
          <Route path="/transport/lrs/:id/edit"   element={<LrFormPage />} />
          <Route path="/transport/trips"          element={<TripsPage />} />
          <Route path="/transport/trips/:id"      element={<TripDetailPage />} />
          <Route path="/transport/billing"        element={<FreightBillingPage />} />
          <Route path="/transport/goods-bills/new" element={<GoodsBillPage />} />
          <Route path="/transport/vehicles"       element={<VehiclesPage />} />
          <Route path="/transport/vehicles/:id"   element={<VehicleDetailPage />} />
          <Route path="/transport/drivers"        element={<DriversPage />} />
          <Route path="/transport/routes"         element={<RoutesPage />} />
          <Route path="/transport/compliance"     element={<CompliancePage />} />
          <Route path="/transport/expenses"       element={<TransportExpensesPage />} />
          <Route path="/transport/reports"        element={<TransportReportsPage />} />
          <Route path="/transport/bank"           element={<BankPage />} />
          <Route path="/transport/ca"             element={<CaReportsPage />} />
          <Route path="/transport/messages"       element={<MessagesPage />} />

          {/* ── Billing core ── */}
          <Route path="/invoices" element={<InvoiceListPage />} />
          <Route path="/invoices/new" element={<CreateInvoicePage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/parties" element={<PartyListPage />} />
          <Route path="/parties/:id" element={<PartyStatementPage />} />

          {/* ── Stores (tyres, spares, lubricants) with shared sub-nav ── */}
          <Route path="/inventory" element={<InventoryLayout />}>
            <Route index element={<Navigate to="/inventory/stock" replace />} />
            <Route path="stock"                element={<StockLevelsPage />} />
            <Route path="products"             element={<ProductListPage />} />
            <Route path="suppliers"            element={<SuppliersPage />} />
            <Route path="purchase-orders"      element={<PurchaseOrdersPage />} />
            <Route path="purchase-orders/:id"  element={<PurchaseOrderDetailPage />} />
            <Route path="adjustments"          element={<StockAdjustmentPage />} />
            <Route path="transfers"            element={<StockTransfersPage />} />
          </Route>

          <Route path="/expenses" element={<ExpensePage />} />
          <Route path="/branches" element={<BranchesPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/advances" element={<AdvancesPage />} />
          <Route path="/inventory/grn" element={<GRNPage />} />
          <Route path="/aging" element={<AgingPage />} />

          {/* Legacy /products redirect */}
          <Route path="/products" element={<Navigate to="/inventory/products" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
