import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface ModalProps {
  title:     string
  onClose:   () => void
  children:  ReactNode
  footer?:   ReactNode
  width?:    'md' | 'lg' | 'xl'
}

const WIDTH = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const

/** Centered modal in the same visual language as the rest of the app. */
export function Modal({ title, onClose, children, footer, width = 'lg' }: ModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`bg-white rounded-xl w-full ${WIDTH[width]} max-h-[95vh] flex flex-col`}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && <div className="flex gap-2 p-5 border-t border-gray-100 shrink-0">{footer}</div>}
      </div>
    </div>
  )
}
