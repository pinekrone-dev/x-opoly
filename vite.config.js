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
    build: {
        outDir: 'dist',
        sourcemap: false,
        // One HTML entry per public page, so each carries its own title and
        // link preview for crawlers; they all load the same app, which routes
        // by path. The asset host serves /investors from investors.html.
        rollupOptions: {
            input: {
                // The pages all load src/main.tsx, so Vite emits one shared bundle
                // named main-<hash>.js; scripts/wait-for-deploy.mjs knows that name.
                index: 'index.html',
                investors: 'investors.html',
                developers: 'developers.html',
                'investment-sales': 'investment-sales.html',
                markets: 'markets.html',
                faq: 'faq.html',
                // /gis exactly; a market deep link such as /gis/phoenix-az falls back
                // to index.html and the root card, which is right for a private map.
                gis: 'gis.html',
            },
        },
    },
});
