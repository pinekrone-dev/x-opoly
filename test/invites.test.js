/**
 * Collaborator invitations.
 *
 * The interesting property is the door they open: registration on a claimed
 * workspace is otherwise closed, and an invite must open it for exactly one
 * person, exactly once.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

const BASE = 'http://localhost'
let ownerCookie = null

async function call(path, init = {}, { cookie = ownerCookie } = {}) {
  const response = await app.fetch(
    new Request(BASE + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(init.headers || {}),
      },
    }),
  )
  const setCookie = response.headers.get('set-cookie')
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body, cookie: setCookie ? setCookie.split(';')[0] : null }
}

const asJson = (payload, method = 'POST') => ({ method, body: JSON.stringify(payload) })

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
  const claimed = await call(
    '/api/auth/register',
    asJson({ name: 'Owner', email: 'owner@example.com', password: 'a long enough password' }),
    { cookie: null },
  )
  ownerCookie = claimed.cookie
})

after(() => temp.cleanup())

describe('collaborator invites', () => {
  test('a second registration is closed without an invitation', async () => {
    const walkIn = await call(
      '/api/auth/register',
      asJson({ name: 'Stranger', email: 'stranger@example.com', password: 'a long enough password' }),
      { cookie: null },
    )
    assert.equal(walkIn.status, 403)
  })

  test('an invite opens the door for its addressee, once', async () => {
    const created = await call('/api/invites', asJson({ email: 'Partner@Example.com' }))
    assert.equal(created.status, 201)
    assert.equal(created.body.invite.email, 'partner@example.com', 'the address is normalised')
    assert.ok(created.body.url.includes('?invite='), 'the link is assembled server-side')
    const token = new URL(created.body.url).searchParams.get('invite')

    // The joining page can ask who this is for, signed out.
    const who = await call(`/api/auth/invite/${token}`, {}, { cookie: null })
    assert.equal(who.status, 200)
    assert.equal(who.body.email, 'partner@example.com')

    // The wrong address is refused before any account is created.
    const wrong = await call(
      '/api/auth/register',
      asJson({
        name: 'Imposter',
        email: 'other@example.com',
        password: 'a long enough password',
        inviteToken: token,
      }),
      { cookie: null },
    )
    assert.equal(wrong.status, 403)
    assert.match(wrong.body.error, /partner@example\.com/)

    // The right address gets in.
    const joined = await call(
      '/api/auth/register',
      asJson({
        name: 'Partner',
        email: 'partner@example.com',
        password: 'a long enough password',
        inviteToken: token,
      }),
      { cookie: null },
    )
    assert.equal(joined.status, 201)

    // And the collaborator sees the workspace's surveys.
    await call('/api/surveys', asJson({ name: 'Team search' }))
    const theirs = await call('/api/surveys', {}, { cookie: joined.cookie })
    assert.ok(theirs.body.surveys.some((survey) => survey.name === 'Team search'))

    // Burned: neither reuse nor the joining page work now.
    const reuse = await call(
      '/api/auth/register',
      asJson({
        name: 'Partner again',
        email: 'partner2@example.com',
        password: 'a long enough password',
        inviteToken: token,
      }),
      { cookie: null },
    )
    assert.equal(reuse.status, 403)
    assert.equal((await call(`/api/auth/invite/${token}`, {}, { cookie: null })).status, 410)

    // The Share tab shows it as used.
    const listed = await call('/api/invites')
    const entry = listed.body.invites.find((invite) => invite.email === 'partner@example.com')
    assert.equal(entry.used, true)
  })

  test('a revoked invite stops working before it is used', async () => {
    const created = await call('/api/invites', asJson({ email: 'gone@example.com' }))
    const token = new URL(created.body.url).searchParams.get('invite')

    const revoked = await call(`/api/invites/${created.body.invite.id}`, { method: 'DELETE' })
    assert.equal(revoked.status, 204)

    assert.equal((await call(`/api/auth/invite/${token}`, {}, { cookie: null })).status, 410)
  })

  test('re-inviting an address replaces the old link', async () => {
    const first = await call('/api/invites', asJson({ email: 'twice@example.com' }))
    const second = await call('/api/invites', asJson({ email: 'twice@example.com' }))
    const oldToken = new URL(first.body.url).searchParams.get('invite')
    const newToken = new URL(second.body.url).searchParams.get('invite')

    assert.equal((await call(`/api/auth/invite/${oldToken}`, {}, { cookie: null })).status, 410)
    assert.equal((await call(`/api/auth/invite/${newToken}`, {}, { cookie: null })).status, 200)
  })

  test('someone who already has an account cannot be invited', async () => {
    const dupe = await call('/api/invites', asJson({ email: 'owner@example.com' }))
    assert.equal(dupe.status, 400)
  })

  test('managing invites needs a session', async () => {
    assert.equal((await call('/api/invites', {}, { cookie: null })).status, 401)
    assert.equal((await call('/api/invites', asJson({ email: 'x@example.com' }), { cookie: null })).status, 401)
  })
})
