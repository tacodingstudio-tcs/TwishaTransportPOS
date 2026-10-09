import { LR_STATUS, TRIP_STATUS, VEHICLE_STATUS, DRIVER_STATUS } from './format'

const MAPS = { lr: LR_STATUS, trip: TRIP_STATUS, vehicle: VEHICLE_STATUS, driver: DRIVER_STATUS } as const

export function StatusPill({ kind, status }: { kind: keyof typeof MAPS; status: string }) {
  const tone = MAPS[kind][status]
  return (
    <span className={`badge ${tone?.cls ?? 'bg-gray-100 text-gray-600'}`}>
      {tone?.label ?? status.replace(/_/g, ' ')}
    </span>
  )
}
