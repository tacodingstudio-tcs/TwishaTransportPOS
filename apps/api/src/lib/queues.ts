// apps/api/src/lib/queues.ts
// Central queue definitions — shared by API (producers) and worker (consumers)

import { Queue } from 'bullmq'
import { redis } from './redis.js'

// PDF generation queue
// Triggered after every confirmed invoice
export const pdfQueue = new Queue('pdf-generation', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50 },
  },
})

// WhatsApp message queue
// Triggered by payment reminders and invoice share actions
export const whatsappQueue = new Queue('whatsapp-send', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 100 },
  },
})

// AI processing queue
// OCR jobs, HSN suggestions, follow-up message drafting
export const aiQueue = new Queue('ai-processing', {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 3000 },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
  },
})
