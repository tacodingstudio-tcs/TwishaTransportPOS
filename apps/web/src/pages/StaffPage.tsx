// src/pages/StaffPage.tsx
// Staff shift scheduling and daily attendance tracking.
import { useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  useStaffUsers, useStaffAttendance, useRecordAttendance,
  useUpdateAttendance, useStaffShifts, useCreateShift, useDeleteShift,
} from '@/hooks/useApi'
import { Users, Clock, Calendar, CheckCircle, XCircle, AlertCircle, Trash2 } from 'lucide-react'
import { useAuthStore } from '@/store/auth.store'

function todayStr() { return new Date().toISOString().slice(0, 10) }
function currentMonth() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
}

const STATUS_COLORS: Record<string, string> = {
  present:  'bg-green-100 text-green-700',
  absent:   'bg-red-100 text-red-600',
  late:     'bg-amber-100 text-amber-700',
  half_day: 'bg-blue-100 text-blue-700',
  holiday:  'bg-gray-100 text-gray-500',
}

const SHIFT_COLORS: Record<string, string> = {
  morning:          'bg-amber-50 border-amber-200 text-amber-800',
  evening:          'bg-purple-50 border-purple-200 text-purple-800',
  night:            'bg-indigo-50 border-indigo-200 text-indigo-800',
  full_day:         'bg-blue-50 border-blue-200 text-blue-800',
  // service/appointment domains
  morning_slot:     'bg-amber-50 border-amber-200 text-amber-800',
  afternoon_slot:   'bg-orange-50 border-orange-200 text-orange-800',
  evening_slot:     'bg-purple-50 border-purple-200 text-purple-800',
  // class / session domains
  morning_class:    'bg-amber-50 border-amber-200 text-amber-800',
  evening_class:    'bg-purple-50 border-purple-200 text-purple-800',
  // event domains
  event:            'bg-green-50 border-green-200 text-green-800',
  half_day_am:      'bg-sky-50 border-sky-200 text-sky-800',
  half_day_pm:      'bg-teal-50 border-teal-200 text-teal-800',
}

// Domain-aware shift type options
const DOMAIN_SHIFT_TYPES: Record<string, Array<{ value: string; label: string }>> = {
  // Petrol pump / hotel / restaurant — time-based shifts
  petrol_pump: [
    { value: 'morning', label: 'Morning Shift' },
    { value: 'evening', label: 'Evening Shift' },
    { value: 'night',   label: 'Night Shift'   },
  ],
  hotel: [
    { value: 'morning', label: 'Morning Shift (6am–2pm)' },
    { value: 'evening', label: 'Evening Shift (2pm–10pm)' },
    { value: 'night',   label: 'Night Shift (10pm–6am)' },
  ],
  restaurant: [
    { value: 'morning', label: 'Breakfast / Lunch' },
    { value: 'evening', label: 'Dinner' },
    { value: 'full_day', label: 'Full Day' },
  ],
  // Salon / spa — appointment slots
  salon: [
    { value: 'morning_slot',   label: 'Morning Slots' },
    { value: 'afternoon_slot', label: 'Afternoon Slots' },
    { value: 'evening_slot',   label: 'Evening Slots' },
    { value: 'full_day',       label: 'Full Day' },
  ],
  // Gym / fitness — class-based
  gym: [
    { value: 'morning_class', label: 'Morning Classes' },
    { value: 'evening_class', label: 'Evening Classes' },
    { value: 'full_day',      label: 'Full Day' },
  ],
  // Event-based domains
  photography: [
    { value: 'event',      label: 'Event / Shoot' },
    { value: 'half_day_am', label: 'Half Day (AM)' },
    { value: 'half_day_pm', label: 'Half Day (PM)' },
    { value: 'full_day',   label: 'Full Day' },
  ],
  catering: [
    { value: 'event',      label: 'Event / Function' },
    { value: 'half_day_am', label: 'Half Day (AM)' },
    { value: 'half_day_pm', label: 'Half Day (PM)' },
    { value: 'full_day',   label: 'Full Day' },
  ],
  // Coaching — class schedule
  coaching: [
    { value: 'morning_class', label: 'Morning Batch' },
    { value: 'evening_class', label: 'Evening Batch' },
    { value: 'full_day',      label: 'Full Day' },
  ],
  // Repair / automobile — job-based but still shift-driven
  repair: [
    { value: 'morning', label: 'Morning' },
    { value: 'evening', label: 'Evening' },
    { value: 'full_day', label: 'Full Day' },
  ],
  automobile: [
    { value: 'morning', label: 'Morning' },
    { value: 'evening', label: 'Evening' },
    { value: 'full_day', label: 'Full Day' },
  ],
}

const DEFAULT_SHIFT_TYPES = [
  { value: 'full_day', label: 'Full Day' },
  { value: 'morning',  label: 'Morning'  },
  { value: 'evening',  label: 'Evening'  },
  { value: 'night',    label: 'Night'    },
]

function getShiftTypes(domainType?: string) {
  return DOMAIN_SHIFT_TYPES[domainType ?? ''] ?? DEFAULT_SHIFT_TYPES
}

function shiftLabel(shiftType: string) {
  return shiftType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const TABS = [
  { key: 'attendance', label: 'Attendance',  icon: CheckCircle },
  { key: 'shifts',     label: 'Shifts',      icon: Calendar    },
]

export function StaffPage() {
  const [tab, setTab] = useState<'attendance' | 'shifts'>('attendance')

  return (
    <div>
      <PageHeader title="Staff" subtitle="Attendance and shift management" />
      <div className="p-8 space-y-5">
        <div className="flex gap-1 border-b border-gray-200">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key as any)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'attendance' && <AttendanceTab />}
        {tab === 'shifts'     && <ShiftsTab />}
      </div>
    </div>
  )
}

// ── Attendance Tab ────────────────────────────────────────────────────────────
function AttendanceTab() {
  const [date, setDate]       = useState(todayStr())
  const [showForm, setForm]   = useState(false)
  const [formUserId, setFUid] = useState('')
  const [formClockIn, setFCI] = useState('')
  const [formClockOut, setFCO] = useState('')
  const [formStatus, setFS]   = useState<string>('present')
  const [formNotes, setFN]    = useState('')

  const { data: usersData }           = useStaffUsers()
  const { data, isLoading, refetch }  = useStaffAttendance({ date })
  const record   = useRecordAttendance()
  const update   = useUpdateAttendance()

  const users: any[]   = usersData?.users ?? []
  const records: any[] = data?.records ?? []
  const summary        = data?.summary ?? { total: 0, present: 0, absent: 0, late: 0 }

  // Users not yet in attendance for today
  const recordedUserIds = new Set(records.map((r: any) => r.user_id))
  const unrecordedUsers = users.filter(u => !recordedUserIds.has(u.id))

  function resetForm() {
    setFUid(''); setFCI(''); setFCO(''); setFS('present'); setFN(''); setForm(false)
  }

  function handleSubmit() {
    if (!formUserId) return
    record.mutate({
      userId:   formUserId,
      date,
      clockIn:  formClockIn  || undefined,
      clockOut: formClockOut || undefined,
      status:   formStatus,
      notes:    formNotes    || undefined,
    }, { onSuccess: () => { resetForm(); refetch() } })
  }

  function handleClockOut(id: string) {
    const now = new Date()
    const hh  = String(now.getHours()).padStart(2, '0')
    const mm  = String(now.getMinutes()).padStart(2, '0')
    update.mutate({ id, data: { clockOut: `${hh}:${mm}` } }, { onSuccess: () => refetch() })
  }

  return (
    <div className="space-y-5">
      {/* Date + controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-gray-500" htmlFor="att-date">Date</label>
        <input id="att-date" type="date" title="Attendance date" value={date}
          onChange={(e) => setDate(e.target.value)}
          className="input text-sm w-44" max={todayStr()} />
        <button type="button" onClick={() => setForm(true)}
          className="btn btn-primary text-sm px-4 py-2 ml-auto">
          + Mark Attendance
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total Staff',  value: users.length, icon: Users,        color: 'text-gray-700' },
          { label: 'Present',      value: summary.present, icon: CheckCircle, color: 'text-green-700' },
          { label: 'Absent',       value: summary.absent,  icon: XCircle,     color: 'text-red-600'   },
          { label: 'Late',         value: summary.late,    icon: AlertCircle, color: 'text-amber-700' },
        ].map((c) => (
          <div key={c.label} className="card p-4 flex items-center gap-3">
            <c.icon className={`w-8 h-8 ${c.color} opacity-80`} />
            <div>
              <div className="text-xs text-gray-500">{c.label}</div>
              <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Attendance form */}
      {showForm && (
        <div className="card p-5 space-y-4 max-w-lg">
          <h3 className="text-sm font-semibold text-gray-900">Mark Attendance for {date}</h3>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Staff Member *</label>
            <select title="Select staff member" value={formUserId}
              onChange={(e) => setFUid(e.target.value)}
              className="input w-full text-sm">
              <option value="">Select staff…</option>
              {users.map((u: any) => (
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block" htmlFor="clock-in">Clock In</label>
              <input id="clock-in" type="time" title="Clock in time" value={formClockIn}
                onChange={(e) => setFCI(e.target.value)} className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block" htmlFor="clock-out">Clock Out</label>
              <input id="clock-out" type="time" title="Clock out time" value={formClockOut}
                onChange={(e) => setFCO(e.target.value)} className="input text-sm w-full" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Status</label>
            <select title="Attendance status" value={formStatus}
              onChange={(e) => setFS(e.target.value)} className="input w-full text-sm">
              <option value="present">Present</option>
              <option value="absent">Absent</option>
              <option value="late">Late</option>
              <option value="half_day">Half Day</option>
              <option value="holiday">Holiday</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block" htmlFor="att-notes">Notes</label>
            <input id="att-notes" type="text" title="Notes" value={formNotes}
              onChange={(e) => setFN(e.target.value)}
              placeholder="Optional notes" className="input text-sm w-full" />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={resetForm} className="btn btn-ghost text-sm px-4 py-2 flex-1">Cancel</button>
            <button type="button" onClick={handleSubmit}
              disabled={!formUserId || record.isPending}
              className="btn btn-primary text-sm px-4 py-2 flex-1 disabled:opacity-50">
              {record.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Attendance table */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : (
        <div className="card overflow-hidden">
          {records.length === 0 && unrecordedUsers.length === 0 ? (
            <div className="p-10 text-center text-gray-400">
              <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No staff members found. Add users from Branches settings.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left">Staff Member</th>
                  <th className="px-4 py-3 text-left">Role</th>
                  <th className="px-4 py-3 text-center">Clock In</th>
                  <th className="px-4 py-3 text-center">Clock Out</th>
                  <th className="px-4 py-3 text-center">Hours</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {records.map((r: any) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{r.user_name}</td>
                    <td className="px-4 py-3 text-gray-500 capitalize">{r.user_role}</td>
                    <td className="px-4 py-3 text-center font-mono text-gray-700">{r.clock_in ?? '—'}</td>
                    <td className="px-4 py-3 text-center font-mono text-gray-700">{r.clock_out ?? '—'}</td>
                    <td className="px-4 py-3 text-center text-gray-600">
                      {r.hours_worked != null ? `${r.hours_worked}h` : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.clock_in && !r.clock_out && (
                        <button type="button"
                          onClick={() => handleClockOut(r.id)}
                          className="text-xs text-primary-600 hover:underline">
                          Clock Out
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {/* Unrecorded staff */}
                {unrecordedUsers.map((u: any) => (
                  <tr key={u.id} className="bg-red-50/40">
                    <td className="px-4 py-3 font-medium text-gray-700">{u.name}</td>
                    <td className="px-4 py-3 text-gray-400 capitalize">{u.role}</td>
                    <td className="px-4 py-3 text-center text-gray-300">—</td>
                    <td className="px-4 py-3 text-center text-gray-300">—</td>
                    <td className="px-4 py-3 text-center text-gray-300">—</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-400">
                        not marked
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button"
                        onClick={() => { setFUid(u.id); setForm(true) }}
                        className="text-xs text-primary-600 hover:underline">
                        Mark
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ── Shifts Tab ────────────────────────────────────────────────────────────────
function ShiftsTab() {
  const domainType = useAuthStore((s) => s.branch?.domainType as string | undefined)
  const shiftTypes = getShiftTypes(domainType)

  const [from,   setFrom]   = useState(todayStr())
  const [to,     setTo]     = useState(todayStr())
  const [showForm, setForm] = useState(false)
  const [fUserId, setFUid]  = useState('')
  const [fDate,   setFDate] = useState(todayStr())
  const [fType,   setFType] = useState<string>(shiftTypes[0]?.value ?? 'full_day')
  const [fStart,  setFStart] = useState('')
  const [fEnd,    setFEnd]   = useState('')
  const [fNotes,  setFNotes] = useState('')

  const { data: usersData }          = useStaffUsers()
  const { data, isLoading, refetch } = useStaffShifts({ from, to })
  const create = useCreateShift()
  const remove = useDeleteShift()

  const users: any[]  = usersData?.users ?? []
  const shifts: any[] = data?.shifts ?? []

  function resetForm() {
    setFUid(''); setFDate(todayStr()); setFType('full_day')
    setFStart(''); setFEnd(''); setFNotes(''); setForm(false)
  }

  function handleCreate() {
    if (!fUserId) return
    create.mutate({
      userId:     fUserId,
      date:       fDate,
      shiftType:  fType,
      shiftStart: fStart || undefined,
      shiftEnd:   fEnd   || undefined,
      notes:      fNotes || undefined,
    }, { onSuccess: () => { resetForm(); refetch() } })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-gray-500" htmlFor="shift-from">From</label>
        <input id="shift-from" type="date" title="From date" value={from}
          onChange={(e) => setFrom(e.target.value)} className="input text-sm w-44" />
        <label className="text-sm text-gray-500" htmlFor="shift-to">To</label>
        <input id="shift-to" type="date" title="To date" value={to}
          onChange={(e) => setTo(e.target.value)} className="input text-sm w-44" />
        <button type="button" onClick={() => setForm(true)}
          className="btn btn-primary text-sm px-4 py-2 ml-auto">
          + Schedule Shift
        </button>
      </div>

      {showForm && (
        <div className="card p-5 space-y-4 max-w-lg">
          <h3 className="text-sm font-semibold text-gray-900">Schedule Shift</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">Staff Member *</label>
              <select title="Select staff member" value={fUserId}
                onChange={(e) => setFUid(e.target.value)} className="input w-full text-sm">
                <option value="">Select staff…</option>
                {users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block" htmlFor="sh-date">Date</label>
              <input id="sh-date" type="date" title="Shift date" value={fDate}
                onChange={(e) => setFDate(e.target.value)} className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Shift Type</label>
              <select title="Shift type" value={fType}
                onChange={(e) => setFType(e.target.value)} className="input w-full text-sm">
                {shiftTypes.map((st) => (
                  <option key={st.value} value={st.value}>{st.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block" htmlFor="sh-start">Start Time</label>
              <input id="sh-start" type="time" title="Shift start time" value={fStart}
                onChange={(e) => setFStart(e.target.value)} className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block" htmlFor="sh-end">End Time</label>
              <input id="sh-end" type="time" title="Shift end time" value={fEnd}
                onChange={(e) => setFEnd(e.target.value)} className="input text-sm w-full" />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block" htmlFor="sh-notes">Notes</label>
              <input id="sh-notes" type="text" title="Notes" value={fNotes}
                onChange={(e) => setFNotes(e.target.value)}
                placeholder="Optional notes" className="input text-sm w-full" />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={resetForm} className="btn btn-ghost text-sm px-4 py-2 flex-1">Cancel</button>
            <button type="button" onClick={handleCreate}
              disabled={!fUserId || create.isPending}
              className="btn btn-primary text-sm px-4 py-2 flex-1 disabled:opacity-50">
              {create.isPending ? 'Saving…' : 'Schedule'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : shifts.length === 0 ? (
        <div className="card p-10 text-center">
          <Calendar className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-400">No shifts scheduled for this range.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 border-b border-gray-100">
              <tr>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Staff Member</th>
                <th className="px-4 py-3 text-left">Shift</th>
                <th className="px-4 py-3 text-center">Time</th>
                <th className="px-4 py-3 text-left">Notes</th>
                <th className="px-4 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {shifts.map((s: any) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700">{s.date}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{s.user_name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${SHIFT_COLORS[s.shift_type] ?? 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                      {shiftLabel(s.shift_type)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600 font-mono text-xs">
                    {s.shift_start && s.shift_end ? `${s.shift_start} – ${s.shift_end}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{s.notes ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button"
                      onClick={() => remove.mutate(s.id, { onSuccess: () => refetch() })}
                      className="p-1 text-gray-300 hover:text-red-500 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
