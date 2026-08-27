import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
var apiTarget = process.env.API_URL || 'http://127.0.0.1:8080';
// The same CI-injected SHA scripts/build-info.mjs stamps into the Worker.
// Baking it into the bundle lets a running tab compare itself against
// /api/health and notice it has gone stale, instead of failing opaquely.
var buildCommit = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || 'dev';
export default defineConfig({
    plugins: [react()],
    define: { __BUILD_COMMIT__: JSON.stringify(buildCommit) },
    server: {
        port: 5173,
        proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
    build: { outDir: 'dist', sourcemap: false },
});
