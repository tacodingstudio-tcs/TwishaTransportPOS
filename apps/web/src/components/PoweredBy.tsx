// "Powered by …" credit shown on the sign-in page, the app's top bar and the printed documents.
// Name and link come from the build environment so they can be changed without touching code:
//   VITE_POWERED_BY_NAME   default "Twisha Consultancy Services"
//   VITE_POWERED_BY_URL    default https://www.twishaconsultancyservices.com/
const NAME = (import.meta.env['VITE_POWERED_BY_NAME'] as string | undefined)?.trim() || 'Twisha Consultancy Services'
const URL_ = (import.meta.env['VITE_POWERED_BY_URL'] as string | undefined)?.trim() || 'https://www.twishaconsultancyservices.com/'

/** "Powered by <name>" — grey lead-in, bold green company name that links to the company site. */
function Line({ className, size }: { className: string; size: string }) {
  return (
    <p className={`${size} text-gray-500 ${className}`}>
      Powered by{' '}
      {URL_
        ? <a href={URL_} target="_blank" rel="noopener noreferrer" className="font-bold text-primary-700 hover:text-primary-800 hover:underline">{NAME}</a>
        : <span className="font-bold text-primary-700">{NAME}</span>}
    </p>
  )
}

/** Small line for printed pages and corners. */
export function PoweredBy({ className = '' }: { className?: string }) {
  return <Line className={className} size="text-[11px]" />
}

/** The app's top bar. */
export function PoweredByCompact() {
  return <Line className="hidden sm:block" size="text-xs" />
}

/** The sign-in page. */
export function PoweredByBadge({ className = '' }: { className?: string }) {
  return <Line className={`text-center ${className}`} size="text-sm" />
}
