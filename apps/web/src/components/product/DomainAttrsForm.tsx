import { getDomainAttrs, type AttrField } from '@/config/domainProductAttrs'

interface Props {
  domainType: string
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}

function FieldInput({ f, val, onSet }: {
  f: AttrField
  val: unknown
  onSet: (v: unknown) => void
}) {
  const base = 'input'

  if (f.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 h-9 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={Boolean(val)}
          onChange={(e) => onSet(e.target.checked)}
          className="w-4 h-4 accent-primary-600"
        />
        <span className="text-sm text-gray-600">{val ? 'Yes' : 'No'}</span>
      </label>
    )
  }

  if (f.type === 'textarea') {
    return (
      <textarea
        id={`attr-${f.key}`}
        rows={2}
        placeholder={f.placeholder}
        title={f.label}
        value={String(val ?? '')}
        onChange={(e) => onSet(e.target.value)}
        className="input resize-none"
      />
    )
  }

  if (f.type === 'select' && f.options) {
    return (
      <select
        id={`attr-${f.key}`}
        title={f.label}
        value={String(val ?? '')}
        onChange={(e) => onSet(e.target.value)}
        className={base}
      >
        <option value="">— Select —</option>
        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }

  if (f.type === 'date') {
    return (
      <input
        id={`attr-${f.key}`}
        type="date"
        title={f.label}
        value={String(val ?? '')}
        onChange={(e) => onSet(e.target.value)}
        className={base}
      />
    )
  }

  if (f.type === 'number') {
    return (
      <input
        id={`attr-${f.key}`}
        type="number"
        placeholder={f.placeholder}
        title={f.label}
        value={String(val ?? '')}
        onChange={(e) => onSet(e.target.value === '' ? '' : Number(e.target.value))}
        className={base}
      />
    )
  }

  return (
    <input
      id={`attr-${f.key}`}
      type="text"
      placeholder={f.placeholder}
      title={f.label}
      value={String(val ?? '')}
      onChange={(e) => onSet(e.target.value)}
      className={base}
    />
  )
}

export function DomainAttrsForm({ domainType, values, onChange }: Props) {
  const fields = getDomainAttrs(domainType)
  if (fields.length === 0) return null

  function set(key: string, val: unknown) {
    onChange({ ...values, [key]: val })
  }

  // Group fields into sections
  type Section = { title: string | null; fields: AttrField[] }
  const sections: Section[] = []
  let current: Section = { title: null, fields: [] }

  for (const f of fields) {
    if (f.section) {
      if (current.fields.length > 0 || current.title !== null) sections.push(current)
      current = { title: f.section, fields: [] }
    }
    current.fields.push(f)
  }
  if (current.fields.length > 0) sections.push(current)

  return (
    <div className="space-y-4 border-t border-gray-100 pt-4 mt-2">
      {sections.map((sec, si) => (
        <div key={si}>
          {sec.title && (
            <p className="text-xs font-semibold text-primary-600 uppercase tracking-wide mb-2 mt-1">
              {sec.title}
            </p>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {sec.fields.map((f) => (
              <div key={f.key} className={f.wide ? 'col-span-2' : ''}>
                <label className="label text-xs" htmlFor={`attr-${f.key}`}>
                  {f.label}
                  {f.unit && <span className="text-gray-400 font-normal ml-1">({f.unit})</span>}
                </label>
                <FieldInput f={f} val={values[f.key]} onSet={(v) => set(f.key, v)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
