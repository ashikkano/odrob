// ═══════════════════════════════════════════════════════════════════
// PM2 Ecosystem — keeps backend & frontend alive
//
// Usage:
//   npx pm2 start ecosystem.config.cjs          # start all
//   npx pm2 logs                                 # stream all logs
//   npx pm2 logs backend                         # backend logs only
//   npx pm2 restart backend                      # restart backend
//   npx pm2 stop all                             # stop all
//   npx pm2 delete all                           # remove all
//   npx pm2 monit                                # live dashboard
//
// Fresh DB:
//   npx pm2 stop backend && rm -f server/data/odrob.db* && npx pm2 restart backend
// ═══════════════════════════════════════════════════════════════════

const backendPort = Number(process.env.PORT || process.env.APP_BACKEND_PORT || 3001)
const frontendPort = Number(process.env.VITE_PORT || process.env.APP_FRONTEND_PORT || 3000)

module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'server/index.js',
      cwd: __dirname,
      node_args: '--experimental-vm-modules',
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: backendPort,
      },
      // Log files
      out_file: '/tmp/odrob-backend.log',
      error_file: '/tmp/odrob-backend-error.log',
      merge_logs: true,
      log_date_format: 'HH:mm:ss',
    },
    {
      name: 'frontend',
      script: 'npx',
      args: `vite --port ${frontendPort}`,
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'development',
      },
      // Log files
      out_file: '/tmp/odrob-frontend.log',
      error_file: '/tmp/odrob-frontend-error.log',
      merge_logs: true,
      log_date_format: 'HH:mm:ss',
    },
  ],
}
