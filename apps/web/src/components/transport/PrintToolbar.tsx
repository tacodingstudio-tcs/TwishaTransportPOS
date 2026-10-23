// Bar above a printable document (outside the app shell): a way back, a way home, the firm switch, and the page's own buttons.
// Hidden when printing.
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Home } from 'lucide-react'
import { FirmMenu } from '@/components/layout/FirmSwitcher'

export function PrintToolbar({ width, children }: { width: number; children?: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="mx-auto mb-4 flex items-center gap-2 print:hidden" style={{ maxWidth: width }}>
      <button type="button" className="btn-ghost" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}><ArrowLeft className="w-4 h-4" /> Back</button>
      <Link to="/" className="btn-ghost"><Home className="w-4 h-4" /> Home</Link>
      <FirmMenu />
      <span className="flex-1" />
      {children}
    </div>
  )
}
