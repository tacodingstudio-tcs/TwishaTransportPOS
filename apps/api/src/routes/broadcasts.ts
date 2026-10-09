// apps/api/src/routes/broadcasts.ts

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

export const broadcastRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/broadcasts/celebrations?days=7
  // Returns customers whose birthday or anniversary falls within the next N days.
  // Matches by MM-DD only (year-agnostic).
  app.get('/celebrations', async (req, reply) => {
    const { days } = z.object({
      days: z.coerce.number().min(1).max(30).default(7),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    // Build an array of MM-DD strings for today through today+days
    const dates: string[] = []
    for (let i = 0; i <= days; i++) {
      const d = new Date()
      d.setDate(d.getDate() + i)
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      dates.push(`${mm}-${dd}`)
    }

    const inList = dates.map(d => `'${d}'`).join(',')

    const rows = await db.$queryRawUnsafe<Array<{
      id: string; name: string; phone: string | null
      dob: string | null; anniversary: string | null
    }>>(`
      SELECT id::text, name, phone,
        meta->>'dob'         AS dob,
        meta->>'anniversary' AS anniversary
      FROM parties
      WHERE "branchId" = $1::uuid
        AND "isActive" = true
        AND type IN ('customer','both')
        AND (
          TO_CHAR((meta->>'dob')::date, 'MM-DD')         IN (${inList})
          OR TO_CHAR((meta->>'anniversary')::date, 'MM-DD') IN (${inList})
        )
      ORDER BY name ASC
    `, branchId)

    const today = new Date()
    const todayMD = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`

    const result = rows.map((r) => {
      const dobMD  = r.dob         ? r.dob.slice(5).replace('-','-')         : null  // MM-DD from YYYY-MM-DD
      const annMD  = r.anniversary ? r.anniversary.slice(5).replace('-','-') : null

      const dobDaysAway  = dobMD  ? dates.indexOf(dobMD)  : -1
      const annDaysAway  = annMD  ? dates.indexOf(annMD)  : -1

      return {
        id:           r.id,
        name:         r.name,
        phone:        r.phone,
        dob:          r.dob,
        anniversary:  r.anniversary,
        dobToday:     dobMD  === todayMD,
        annToday:     annMD  === todayMD,
        dobDaysAway:  dobDaysAway  >= 0 ? dobDaysAway  : null,
        annDaysAway:  annDaysAway  >= 0 ? annDaysAway  : null,
      }
    })

    const todayCount = result.filter(r => r.dobToday || r.annToday).length

    return reply.send({ celebrations: result, todayCount, total: result.length })
  })

  // GET /api/broadcasts/contacts
  app.get('/contacts', async (req, reply) => {
    try {
      const q = z.object({
        minSpend:   z.coerce.number().default(0),
        minLoyalty: z.coerce.number().default(0),
      }).parse(req.query)

      const db       = req.db
      const branchId = req.branchId

      console.log('[broadcast] branchId:', branchId, 'minSpend:', q.minSpend)

      const parties = await db.party.findMany({
        where: {
          branchId,
          isActive: true,
          type: { in: ['customer', 'both'] },
        },
        select: {
          id:        true,
          name:      true,
          phone:     true,
          loyaltyPts: true,
        },
        orderBy: { name: 'asc' },
        take: 500,
      })

      console.log('[broadcast] parties found:', parties.length)

      const contacts = parties
        .filter((p: any) => p.phone && p.phone.trim() !== '')
        .filter((p: any) => q.minLoyalty === 0 || p.loyaltyPts >= q.minLoyalty)
        .map((p: any) => ({
          id:           p.id,
          name:         p.name,
          phone:        p.phone,
          loyaltyPts:   p.loyaltyPts,
          totalSpend:   0,
          lastPurchase: null,
        }))

      console.log('[broadcast] contacts with phone:', contacts.length)

      return reply.send({ contacts, total: contacts.length })
    } catch (err: any) {
      console.error('[broadcast] ERROR:', err?.message, err?.stack)
      return reply.status(500).send({ error: err?.message ?? 'Unknown error' })
    }
  })
}
