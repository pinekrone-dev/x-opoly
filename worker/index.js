/**
 * Cloudflare Worker entry point.
 *
 * The API is the same module the Node server uses. What changes here is only
 * the plumbing: D1 instead of a SQLite file, R2 instead of a directory, and
 * Cloudflare's static asset binding for the built UI.
 *
 * Bindings expected (see wrangler.toml):
 *   DB      — D1 database
 *   BUCKET  — R2 bucket for flyers and photos
 *   ASSETS  — the built frontend in ./dist
 */

import { createApp } from '../app/routes.js'
import { d1Adapter } from '../app/lib/sql.js'
import { r2Storage } from '../app/lib/storage.js'
import { isHtml, withPreviewOrigin } from '../app/lib/preview.js'

/**
 * Built once per environment and reused for the life of the isolate.
 *
 * Keyed on the env object rather than cached in module scope: a plain module
 * singleton binds the app to whichever environment happened to arrive first,
 * which silently serves later requests from the wrong bindings and wrong
 * configuration. The WeakMap keeps the reuse without that coupling.
 */
const apps = new WeakMap()

/**
 * Schema migration, run once per isolate.
 *
 * The Node server migrates at startup; the Worker has no startup, so for a
 * while it did not migrate at all. The D1 schema was applied out of band
 * instead, which meant a schema change shipped in code was invisible in
 * production until someone remembered to run it by hand — and the first
 * request that needed a new table failed with `no such table`.
 *
 * Applying it lazily costs one PRAGMA sweep on a cold start and makes the
 * deployment self-healing. A failure is not cached: the promise is cleared so
 * the next request tries again rather than the isolate wedging on a transient
 * D1 error.
 */
const schemas = new WeakMap()

function ensureSchema(env) {
  let pending = schemas.get(env)
  if (!pending) {
    pending = d1Adapter(env.DB)
      .migrate()
      .catch((error) => {
        schemas.delete(env)
        throw error
      })
    schemas.set(env, pending)
  }
  return pending
}

function appFor(env) {
  let app = apps.get(env)
  if (!app) {
    app = createApp({
      db: d1Adapter(env.DB),
      storage: r2Storage(env.BUCKET),
      env,
    })
    apps.set(env, app)
  }
  return app
}

/**
 * Shown when the Worker is running but the built frontend is not there.
 *
 * A deploy whose build step never ran uploads an empty asset directory, and
 * the site then answers every page with a bare 404 that says nothing about
 * why. This turns that dead end into the actual diagnosis.
 */
function missingAssetsPage(reason) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frontend not deployed</title>
<style>
  body { font: 15px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3;
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 2rem; }
  main { max-width: 34rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { color: #9aa7b5; margin: .6rem 0; }
  code { background: #161b22; padding: .15rem .4rem; border-radius: 4px; color: #e6edf3; }
  ol { color: #9aa7b5; padding-left: 1.2rem; }
  li { margin: .4rem 0; }
  a { color: #14b8a6; }
</style>
</head>
<body>
<main>
  <h1>The API is running, but the frontend was not uploaded.</h1>
  <p>The Worker deployed and is serving requests — <a href="/api/health">/api/health</a> should return JSON.
     What is missing is the built site, so there is nothing to show at this address.</p>
  <p>Almost always this means the deploy ran without a build step, so <code>dist/</code> was empty:</p>
  <ol>
    <li>Workers &amp; Pages → this Worker → Settings → Build</li>
    <li>Set <strong>Build command</strong> to <code>npm run build</code></li>
    <li>Check <strong>Production branch</strong> matches the branch holding the app</li>
    <li>Retry the deployment</li>
  </ol>
  <p style="color:#6b7684;font-size:13px">Diagnostic: ${reason}</p>
</main>
</body>
</html>`
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // One canonical hostname: any www-prefixed variant 301s to the bare
    // domain, keeping path and query. The DNS record and Worker route for
    // the www name still have to exist in Cloudflare for this to be reached.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4)
      return Response.redirect(url.toString(), 301)
    }

    if (url.pathname.startsWith('/api/')) {
      if (env.DB) {
        // Let the request through even if migrating failed: routes that do not
        // touch the database still work, and the ones that do will report the
        // real error rather than this one.
        await ensureSchema(env).catch(() => undefined)
      }
      return appFor(env).fetch(request, env, ctx)
    }

    // Everything else is the single-page app. `not_found_handling` in
    // wrangler.toml makes the asset binding serve index.html for deep links
    // such as /survey/:id and /s/:token.
    if (!env.ASSETS) {
      return new Response(missingAssetsPage('the ASSETS binding is not present on this deployment'), {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    let response
    try {
      response = await env.ASSETS.fetch(request)
    } catch (error) {
      return new Response(missingAssetsPage(`the asset store could not be read (${error.message})`), {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    // A 404 on a navigation means index.html itself is absent — an empty
    // upload. Asset files (/assets/*.js) keep their real 404.
    const wantsHtml = (request.headers.get('accept') || '').includes('text/html')
    if (response.status === 404 && wantsHtml) {
      return new Response(missingAssetsPage('the asset store returned 404 for index.html'), {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    // Point the link-preview tags at the host that actually answered, so a
    // shared URL previews as itself whichever domain it was handed out on.
    if (isHtml(response)) {
      const html = withPreviewOrigin(await response.text(), url.origin)
      return new Response(html, { status: response.status, headers: response.headers })
    }

    return response
  },
}
