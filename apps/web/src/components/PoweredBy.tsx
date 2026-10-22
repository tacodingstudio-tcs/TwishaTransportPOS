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
