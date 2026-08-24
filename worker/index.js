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

/**
 * Built once per environment and reused for the life of the isolate.
 *
 * Keyed on the env object rather than cached in module scope: a plain module
 * singleton binds the app to whichever environment happened to arrive first,
 * which silently serves later requests from the wrong bindings and wrong
 * configuration. The WeakMap keeps the reuse without that coupling.
 */
const apps = new WeakMap()

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return appFor(env).fetch(request, env, ctx)
    }

    // Everything else is the single-page app. `not_found_handling` in
    // wrangler.toml makes the asset binding serve index.html for deep links
    // such as /survey/:id and /s/:token.
    return env.ASSETS.fetch(request)
  },
}
