// src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/auth.store'
import { AppLayout } from './components/layout/AppLayout'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { DashboardPage } from './pages/DashboardPage'
import { InvoiceListPage } from './pages/InvoiceListPage'
import { CreateInvoicePage } from './pages/CreateInvoicePage'
import { InvoiceDetailPage } from './pages/InvoiceDetailPage'
import { ProductListPage } from './pages/ProductListPage'
import { PartyListPage } from './pages/PartyListPage'
import { PartyStatementPage } from './pages/PartyStatementPage'
import { AIPage } from './pages/AIPage'
import { InventoryLayout } from './pages/inventory/InventoryLayout'
import { StockLevelsPage } from './pages/inventory/StockLevelsPage'
import { SuppliersPage } from './pages/inventory/SuppliersPage'
import { PurchaseOrdersPage } from './pages/inventory/PurchaseOrdersPage'
import { PurchaseOrderDetailPage } from './pages/inventory/PurchaseOrderDetailPage'
import { StockAdjustmentPage } from './pages/inventory/StockAdjustmentPage'
import { StockTransfersPage } from './pages/inventory/StockTransfersPage'
import { ExpensePage } from './pages/ExpensePage'
import { BranchesPage } from './pages/BranchesPage'
import { ReportsPage } from './pages/ReportsPage'
import { StaffPage } from './pages/StaffPage'
import DocumentPipelinePage from './pages/DocumentPipelinePage'
import ApprovalsPage from './pages/ApprovalsPage'
import ContractsPage from './pages/ContractsPage'
import AdvancesPage from './pages/AdvancesPage'
import GRNPage from './pages/inventory/GRNPage'
import AgingPage from './pages/AgingPage'
import { BroadcastPage } from './pages/BroadcastPage'

// Transport
import { TransportDashboardPage } from './pages/transport/TransportDashboardPage'
import { LorryReceiptsPage }      from './pages/transport/LorryReceiptsPage'
import { LrFormPage }             from './pages/transport/LrFormPage'
import { QuickEntryPage }         from './pages/transport/QuickEntryPage'
import { FreightBillPrintPage }   from './pages/transport/FreightBillPrintPage'
import { LrDetailPage }           from './pages/transport/LrDetailPage'
import { LrPrintPage }            from './pages/transport/LrPrintPage'
import { TripsPage }              from './pages/transport/TripsPage'
import { TripDetailPage }         from './pages/transport/TripDetailPage'
import { FreightBillingPage }     from './pages/transport/FreightBillingPage'
import { VehiclesPage }           from './pages/transport/VehiclesPage'
import { VehicleDetailPage }      from './pages/transport/VehicleDetailPage'
import { DriversPage }            from './pages/transport/DriversPage'
import { RoutesPage }             from './pages/transport/RoutesPage'
import { CompliancePage }         from './pages/transport/CompliancePage'
import { TransportExpensesPage }  from './pages/transport/TransportExpensesPage'
import { TransportReportsPage }   from './pages/transport/TransportReportsPage'
import { MessagesPage }           from './pages/transport/MessagesPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn())
  if (!isLoggedIn) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Printable consignment note — outside the app shell so only the document prints */}
        <Route path="/transport/lrs/:id/print" element={<ProtectedRoute><LrPrintPage /></ProtectedRoute>} />
        <Route path="/transport/bills/:id/print" element={<ProtectedRoute><FreightBillPrintPage /></ProtectedRoute>} />

        <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
          <Route path="/" element={<TransportDashboardPage />} />
          <Route path="/analytics" element={<DashboardPage />} />

          {/* ── Transport operations ── */}
          <Route path="/transport/lrs"            element={<LorryReceiptsPage />} />
          <Route path="/transport/lrs/new"        element={<LrFormPage />} />
          <Route path="/transport/lrs/quick"      element={<QuickEntryPage />} />
          <Route path="/transport/lrs/:id"        element={<LrDetailPage />} />
          <Route path="/transport/lrs/:id/edit"   element={<LrFormPage />} />
          <Route path="/transport/trips"          element={<TripsPage />} />
          <Route path="/transport/trips/:id"      element={<TripDetailPage />} />
          <Route path="/transport/billing"        element={<FreightBillingPage />} />
          <Route path="/transport/vehicles"       element={<VehiclesPage />} />
          <Route path="/transport/vehicles/:id"   element={<VehicleDetailPage />} />
          <Route path="/transport/drivers"        element={<DriversPage />} />
          <Route path="/transport/routes"         element={<RoutesPage />} />
          <Route path="/transport/compliance"     element={<CompliancePage />} />
          <Route path="/transport/expenses"       element={<TransportExpensesPage />} />
          <Route path="/transport/reports"        element={<TransportReportsPage />} />
          <Route path="/transport/messages"       element={<MessagesPage />} />

          {/* ── Billing core ── */}
          <Route path="/invoices" element={<InvoiceListPage />} />
          <Route path="/invoices/new" element={<CreateInvoicePage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/parties" element={<PartyListPage />} />
          <Route path="/parties/:id" element={<PartyStatementPage />} />
          <Route path="/ai" element={<AIPage />} />

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
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/pipeline" element={<DocumentPipelinePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/advances" element={<AdvancesPage />} />
          <Route path="/inventory/grn" element={<GRNPage />} />
          <Route path="/aging" element={<AgingPage />} />
          <Route path="/broadcast" element={<BroadcastPage />} />

          {/* Legacy /products redirect */}
          <Route path="/products" element={<Navigate to="/inventory/products" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
