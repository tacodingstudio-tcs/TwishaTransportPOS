// "/" shows the transport dashboard for a transport firm and a small billing home for a goods firm.
import { TransportDashboardPage } from './TransportDashboardPage'
import { GoodsHomePage } from './GoodsHomePage'
import { useCurrentFirm } from '@/hooks/useFirms'
import { useAuthStore } from '@/store/auth.store'

export function HomeRoute() {
  const { firm } = useCurrentFirm()
  const savedKind = useAuthStore((s) => (s.branch?.domainConfig as any)?.firm_kind)
  return (firm?.kind ?? savedKind) === 'goods' ? <GoodsHomePage /> : <TransportDashboardPage />
}
