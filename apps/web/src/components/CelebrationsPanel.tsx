// Celebrations bell — shows birthday/anniversary reminders for next 7 days.
// Click the bell → dropdown with customer list → Send WA button per customer.

import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { broadcastApi } from '@/lib/api'
import { Gift, MessageCircle, X, Cake, Heart } from 'lucide-react'

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  return digits
}

function waLink(phone: string, message: string) {
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(message)}`
}

function buildWAMessage(contact: any, businessName: string): string {
  if (contact.dobToday) {
    return `🎂 Dear ${contact.name},\n\nWishing you a very *Happy Birthday*! 🎉\n\nAs a birthday gift, enjoy a special treat from us on your next visit!\n\nWith warm wishes,\n*${businessName}*`
  }
  if (contact.annToday) {
    return `💍 Dear ${contact.name},\n\nWishing you a very *Happy Anniversary*! 🌹\n\nWe hope you have a wonderful celebration. Visit us soon for a special treat!\n\nWith love,\n*${businessName}*`
  }
  if (contact.dobDaysAway != null) {
    return `🎂 Dear ${contact.name},\n\nYour birthday is coming up in ${contact.dobDaysAway} day${contact.dobDaysAway === 1 ? '' : 's'}! 🎉\n\nWe have a special birthday surprise waiting for you at *${businessName}*!\n\nSee you soon!`
  }
  return `💍 Dear ${contact.name},\n\nYour anniversary is in ${contact.annDaysAway} day${contact.annDaysAway === 1 ? '' : 's'}! 🌹\n\nCelebrate the occasion with a visit to *${businessName}* — we have something special for you!\n\nWith best wishes,\n*${businessName}*`
}

function daysLabel(daysAway: number | null): string {
  if (daysAway === 0) return 'Today'
  if (daysAway === 1) return 'Tomorrow'
  return `In ${daysAway} days`
}

export function CelebrationsPanel({ businessName }: { businessName: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['celebrations'],
    queryFn:  () => broadcastApi.getCelebrations(7),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  })

  const celebrations: any[] = data?.celebrations ?? []
  const todayCount: number  = data?.todayCount   ?? 0

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (celebrations.length === 0 && !open) return null

  const todayList    = celebrations.filter(c => c.dobToday || c.annToday)
  const upcomingList = celebrations.filter(c => !c.dobToday && !c.annToday)

  return (
    <div ref={ref} className="relative">
      {/* Bell button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        title="Birthdays & Anniversaries"
      >
        <Gift className="w-5 h-5" />
        {todayCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
            {todayCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-10 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
            <div className="flex items-center gap-2">
              <Gift className="w-4 h-4 text-pink-500" />
              <span className="text-sm font-semibold text-gray-900">Celebrations</span>
              <span className="text-xs text-gray-400">next 7 days</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} title="Close">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {celebrations.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">
                No upcoming birthdays or anniversaries
              </div>
            )}

            {/* Today */}
            {todayList.length > 0 && (
              <div>
                <p className="px-4 py-2 text-xs font-semibold text-red-500 uppercase tracking-wide bg-red-50">
                  🎉 Today
                </p>
                {todayList.map(c => (
                  <CelebrationRow key={`${c.id}-today`} contact={c} businessName={businessName} />
                ))}
              </div>
            )}

            {/* Upcoming */}
            {upcomingList.length > 0 && (
              <div>
                <p className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">
                  Upcoming
                </p>
                {upcomingList.map(c => (
                  <CelebrationRow key={`${c.id}-upcoming`} contact={c} businessName={businessName} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CelebrationRow({ contact, businessName }: { contact: any; businessName: string }) {
  const isBirthday   = contact.dobToday   || contact.dobDaysAway != null
  const isAnniversary = contact.annToday  || contact.annDaysAway != null
  const daysAway      = contact.dobToday || contact.annToday ? 0
    : contact.dobDaysAway ?? contact.annDaysAway

  function sendWA() {
    if (!contact.phone) return
    const msg = buildWAMessage(contact, businessName)
    window.open(waLink(contact.phone, msg), '_blank')
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-50 last:border-0">
      {/* Icon */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
        isBirthday ? 'bg-pink-100' : 'bg-red-100'
      }`}>
        {isBirthday
          ? <Cake  className="w-4 h-4 text-pink-500" />
          : <Heart className="w-4 h-4 text-red-500"  />
        }
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{contact.name}</p>
        <p className="text-xs text-gray-400">
          {isBirthday && isAnniversary
            ? `🎂 Birthday & 💍 Anniversary — ${daysLabel(daysAway)}`
            : isBirthday
            ? `🎂 Birthday — ${daysLabel(daysAway)}`
            : `💍 Anniversary — ${daysLabel(daysAway)}`
          }
        </p>
      </div>

      {/* WA button */}
      {contact.phone ? (
        <button
          type="button"
          onClick={sendWA}
          className="shrink-0 p-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          title={`Send WhatsApp to ${contact.name}`}
        >
          <MessageCircle className="w-3.5 h-3.5" />
        </button>
      ) : (
        <span className="text-xs text-gray-300 shrink-0">No phone</span>
      )}
    </div>
  )
}
