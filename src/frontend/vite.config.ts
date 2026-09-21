import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The browser talks only to Vite's own origin; Vite forwards /api to the
// backend. That removes cross-origin requests from the picture entirely — no
// preflight, no preflight cache, no CORS header to get rewritten in transit,
// and no localhost-vs-127.0.0.1 / IPv4-vs-IPv6 mismatch, because there is only
// one origin involved.
//
// Written after a session where the browser reported
// `Access-Control-Allow-Origin: http://localhost:3000` on responses from this
// project's backend, which sends `*` and has never mentioned port 3000. The
// cause was never identified — an extension, a cached preflight from whatever
// previously held the port, or a local interception layer. Same-origin makes
// the question moot rather than answering it.
//
// VITE_PROXY_TARGET is set by `make dev` from BACKEND_HOST/BACKEND_PORT, so
// changing the port in one place still works.
//
// READ FROM .env TOO, not just the process environment. `process.env` alone
// silently ignores a VITE_PROXY_TARGET written into src/frontend/.env — Vite
// loads .env files into `import.meta.env` for CLIENT code, never into
// `process.env` for this config — so a developer putting it in the obvious
// place got no proxy change and no error. That is the whole reason .env ended
// up carrying an absolute VITE_API_BASE instead: the supported knob appeared
// not to work, so the proxy was bypassed rather than pointed.
//
// Order is deliberate: the process environment wins over the file, so
// `make dev` still overrides a developer's .env rather than being swallowed
// by it — the same precedence the Makefile already documents.
const DEFAULT_TARGET = 'http://127.0.0.1:8001'

export default defineConfig(({ mode }) => {
  // '' as the prefix loads every key, not just VITE_-prefixed ones, so
  // BACKEND_PORT-style names could be added later without another gotcha.
  const fileEnv = loadEnv(mode, __dirname, '')
  const PROXY_TARGET =
    process.env.VITE_PROXY_TARGET ?? fileEnv.VITE_PROXY_TARGET ?? DEFAULT_TARGET

  return {
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: PROXY_TARGET,
        changeOrigin: true,
        // The backend serves /towers, not /api/towers. The prefix exists only
        // to tell Vite what to forward, so it is stripped on the way out.
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // maplibre-gl spawns its heavy work (GeoJSON parsing, tiling, symbol layout)
  // in a Web Worker it resolves via `new Worker(new URL(...))`. Vite's dep
  // pre-bundler rewrites that specifier into .vite/deps/ but does not emit the
  // worker chunk there, so the request 404s in dev.
  //
  // The failure is silent and easy to misread: the worker never starts, so no
  // GeoJSON source ever loads a feature and every circle/symbol layer renders
  // empty — while raster basemap tiles keep working normally, because those
  // are decoded on the main thread. `map.on('error')` never fires either.
  // Symptom is "the map looks fine but has no towers on it".
  //
  // Excluding the package from pre-bundling lets Vite serve maplibre's own
  // ESM (and its worker URL) untouched. Production builds were never affected.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  }
})
