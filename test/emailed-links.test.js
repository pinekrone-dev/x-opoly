/**
 * Every emailed link has to survive the trip back into the app.
 *
 * A link the server sends carries its token in the query string, and only
 * SignIn reads those. But SignIn is not mounted for a signed-out visitor on
 * an instance that sells subscriptions: App shows the landing page instead,
 * unless the query names a token it recognises. A link whose name is missing
 * from that list therefore opens the landing page, and the person who clicked
 * it sees a home page with no explanation and no way forward.
 *
 * That happened to the password reset link. This asserts the two halves stay
 * in step, so the next emailed link cannot ship half-wired.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { describe } from 'node:test'

const routes = fs.readFileSync('app/routes.js', 'utf8')
const app = fs.readFileSync('src/App.tsx', 'utf8')
const signIn = fs.readFileSync('src/views/SignIn.tsx', 'utf8')

/** The query parameters the server puts in emailed links, e.g. `?reset=`. */
const emailed = [...routes.matchAll(/\$\{origin\}\/\?([a-zA-Z]+)=/g)].map((m) => m[1])

describe('emailed links', () => {
  test('the server emails at least the three links we know about', () => {
    for (const name of ['invite', 'verify', 'reset']) {
      assert.ok(emailed.includes(name), `the server should email a ?${name}= link`)
    }
  })

  test('every emailed link keeps the signed-out visitor off the landing page', () => {
    const line = app.split('\n').find((text) => text.includes('const hasLinkToken'))
    assert.ok(line, 'App must decide landing versus sign-in from the query')
    for (const name of new Set(emailed)) {
      assert.ok(
        line.includes(`params.has('${name}')`),
        `?${name}= is emailed but not named in hasLinkToken, so it would open the landing page`,
      )
    }
  })

  test('every emailed link is read by the screen that handles it', () => {
    for (const name of new Set(emailed)) {
      assert.ok(
        signIn.includes(`params.get('${name}')`),
        `?${name}= is emailed but SignIn never reads it`,
      )
    }
  })
})
