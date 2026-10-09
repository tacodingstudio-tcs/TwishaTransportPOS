// ecosystem.config.cjs
// PM2 process manager configuration.
// Run with: pm2 start ecosystem.config.cjs
//
// Processes:
//   transport-api  — Fastify API server (2 workers in cluster mode)
//   transport-worker — PDF + WhatsApp + AI job worker (1 process)
//
// Why not more API workers?
//   Each API worker holds a Postgres connection pool of 10 connections.
//   2 workers = 20 connections to Postgres.
//   On a 4GB server with max_connections=50 that leaves headroom for
//   the worker process + pgAdmin + DBA connections.

module.exports = {
  apps: [
    // ── API Server ──────────────────────────────────────────────────────────
    {
      name:       'transport-api',
      script:     'dist/server.js',
      instances:  2,
      exec_mode:  'cluster',      // Node.js cluster — shares port, load-balances
      watch:      false,
      max_memory_restart: '500M',

      env: {
        NODE_ENV: 'development',
        PORT:     3100,
      },

      env_production: {
        NODE_ENV: 'production',
        PORT:     3100,
      },

      // Graceful restart — wait for in-flight requests to finish
      kill_timeout:   5000,
      listen_timeout: 10000,

      // Log files
      out_file:  'logs/api-out.log',
      error_file:'logs/api-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── Background Worker ───────────────────────────────────────────────────
    {
      name:       'transport-worker',
      script:     'dist/workers/pdf.worker.js',
      instances:  1,
      exec_mode:  'fork',         // Single process — Puppeteer not cluster-safe
      watch:      false,
      max_memory_restart: '800M', // Puppeteer can use 300-500MB per browser

      env: {
        NODE_ENV: 'development',
      },

      env_production: {
        NODE_ENV: 'production',
      },

      out_file:  'logs/worker-out.log',
      error_file:'logs/worker-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Auto-restart if Puppeteer crashes
      autorestart:     true,
      restart_delay:   3000,
      max_restarts:    10,
    },
  ],
}
