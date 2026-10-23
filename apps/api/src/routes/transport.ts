// apps/api/src/routes/transport.ts
// Transport / logistics module — mounted at /api/transport.
//
//   transport-fleet.ts    vehicles, drivers, route rate card, compliance alerts
//   transport-lr.ts       lorry receipts: book → assign → deliver → POD
//   transport-trips.ts    trips (start/complete/cancel) and trip/vehicle expenses
//   transport-billing.ts  freight bills (LR → GST invoice), dashboard, reports
//   transport-firms.ts    several firms in one login: add / switch data, bill numbering, goods bills
//   transport-bank.ts     bank statements: import, match to receipts / pump bills / expenses, reconcile
//   transport-ca.ts       CA reports: registers, TDS, GSTR-3B summary, bank book, combined firms
//
// Data lives in raw-SQL tables (see lib/transport-ddl.ts), scoped per tenant schema
// and per branch. Freight bills reuse the shared invoice service.

import type { FastifyPluginAsync } from 'fastify'
import { transportFleetRoutes }   from './transport-fleet.js'
import { transportLrRoutes }      from './transport-lr.js'
import { transportTripRoutes }    from './transport-trips.js'
import { transportBillingRoutes } from './transport-billing.js'
import { transportEwayRoutes }    from './transport-eway.js'
import { transportCommsRoutes }   from './transport-comms.js'
import { transportFirmRoutes }    from './transport-firms.js'
import { transportBankRoutes }    from './transport-bank.js'
import { transportCaRoutes }      from './transport-ca.js'

export const transportRoutes: FastifyPluginAsync = async (app) => {
  await app.register(transportFleetRoutes)
  await app.register(transportLrRoutes)
  await app.register(transportTripRoutes)
  await app.register(transportBillingRoutes)
  await app.register(transportEwayRoutes)
  await app.register(transportCommsRoutes)
  await app.register(transportFirmRoutes)
  await app.register(transportBankRoutes)
  await app.register(transportCaRoutes)
}
