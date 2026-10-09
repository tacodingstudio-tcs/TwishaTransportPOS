// apps/api/src/workers/index.ts
// Single entrypoint — PM2 runs this as the 'billing-worker' process.
// Importing each worker file starts its BullMQ Worker instance immediately.

import './pdf.worker.js'
import './whatsapp.worker.js'
import './reminder.worker.js'

console.log('[Workers] All workers started (pdf, whatsapp, reminder)')
