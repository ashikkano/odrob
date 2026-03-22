import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

const frontendPort = Number(process.env.VITE_PORT || process.env.APP_FRONTEND_PORT || 3000)
const backendPort = Number(process.env.PORT || process.env.APP_BACKEND_PORT || 3001)
const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${backendPort}`

export default defineConfig({
  plugins: [
    nodePolyfills(),
    react({
      // Fast Refresh — explicit on
      fastRefresh: true,
    }),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: frontendPort,
    strictPort: false,       // fallback to next port if 3000 busy
    host: true,

    // HMR — hot module replacement
    hmr: {
      overlay: true,
      timeout: 5000,
    },

    // File watching — stable on macOS
    watch: {
      usePolling: false,     // native FSEvents is fine on macOS
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/server/**',      // don't watch backend — avoids double-restart noise
        '**/.git/**',
        '**/server/data/**',
      ],
    },

    // Proxy to backend — tolerates backend being down
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // Don't crash Vite when backend is offline
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('\x1b[33m⚠  API proxy error (backend down?)\x1b[0m', err.message)
          })
        },
      },
    },
  },

  // Build settings
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          ton: ['@tonconnect/ui-react', '@ton/core'],
        },
      },
    },
  },

  // Faster dep pre-bundling — pin polyfills to avoid re-optimization loops
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'recharts',
      '@tonconnect/ui-react',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
    entries: ['src/main.jsx'],
  },
})
