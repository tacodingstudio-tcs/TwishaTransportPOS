// "Powered by …" credit shown on the sign-in page.
// Name and link come from the build environment so they can be changed without touching code:
//   VITE_POWERED_BY_NAME   default "Twisha Consultancy Services"
//   VITE_POWERED_BY_URL    default https://www.twishaconsultancyservices.com/
const NAME = (import.meta.env['VITE_POWERED_BY_NAME'] as string | undefined)?.trim() || 'Twisha Consultancy Services'
const URL_ = (import.meta.env['VITE_POWERED_BY_URL'] as string | undefined)?.trim() || 'https://www.twishaconsultancyservices.com/'

export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[11px] text-gray-400 ${className}`}>
      Powered by{' '}
      {URL_
        ? <a href={URL_} target="_blank" rel="noopener noreferrer" className="font-medium text-gray-500 hover:text-primary-600 hover:underline">{NAME}</a>
        : <span className="font-medium text-gray-500">{NAME}</span>}
    </p>
  )
}

/** A prominent badge: logo mark, "Powered by", and the company name as the link. */
export function PoweredByBadge({ className = '' }: { className?: string }) {
  const inner = (
    <>
      <span className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-slate-900 text-sm font-extrabold flex items-center justify-center shrink-0 shadow-sm shadow-amber-500/30">T</span>
      <span className="flex flex-col min-w-0 text-left">
        <span className="text-[10px] uppercase tracking-[0.14em] text-slate-400 leading-tight">Powered by</span>
        <span className="text-sm font-bold text-slate-800 group-hover:text-slate-950 leading-tight truncate">{NAME}</span>
      </span>
    </>
  )
  const cls = `group inline-flex items-center gap-3 pl-1.5 pr-5 py-1.5 rounded-full bg-white ring-1 ring-slate-200 shadow-md shadow-slate-900/5
               hover:ring-amber-300 hover:shadow-lg hover:shadow-amber-500/15 hover:-translate-y-px transition-all ${className}`
  return URL_
    ? <a href={URL_} target="_blank" rel="noopener noreferrer" className={cls} title={`Powered by ${NAME}`}>{inner}</a>
    : <span className={cls}>{inner}</span>
}
