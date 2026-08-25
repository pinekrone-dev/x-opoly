/**
 * The email layer: SendGrid and Resend behind one sendEmail, with the sender
 * line parsed once and network failures translated into the survivable error.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { EmailError, emailConfigured, sendEmail, verificationEmail } from '../app/lib/email.js'

function stubFetch(response = { status: 200, body: {} }) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: response.headers ?? {},
    })
  }
  impl.calls = calls
  return impl
}

const MESSAGE = { to: 'broker@example.com', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' }

describe('configuration', () => {
  test('either provider key opens self-serve signup', () => {
    assert.equal(emailConfigured({}), false)
    assert.equal(emailConfigured({ RESEND_API_KEY: 're_x' }), true)
    assert.equal(emailConfigured({ SENDGRID_API_KEY: 'SG.x' }), true)
  })
})

describe('SendGrid', () => {
  test('sends through the v3 API with plain text before html', async () => {
    const fetchImpl = stubFetch({ status: 202, body: {} })
    await sendEmail({ SENDGRID_API_KEY: 'SG.test', EMAIL_FROM: 'Land Quotient <noreply@example.com>' }, MESSAGE, {
      fetchImpl,
    })

    const { url, init } = fetchImpl.calls[0]
    assert.equal(url, 'https://api.sendgrid.com/v3/mail/send')
    assert.equal(init.headers.authorization, 'Bearer SG.test')
    const body = JSON.parse(init.body)
    assert.deepEqual(body.personalizations, [{ to: [{ email: 'broker@example.com' }] }])
    assert.deepEqual(body.from, { name: 'Land Quotient', email: 'noreply@example.com' })
    assert.equal(body.content[0].type, 'text/plain', 'SendGrid rejects html-first content')
    assert.equal(body.content[1].type, 'text/html')
  })

  test('a bare EMAIL_FROM address gets the product name as display name', async () => {
    const fetchImpl = stubFetch({ status: 202 })
    await sendEmail({ SENDGRID_API_KEY: 'SG.test', EMAIL_FROM: 'hello@example.com' }, MESSAGE, { fetchImpl })
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body).from, {
      name: 'Land Quotient',
      email: 'hello@example.com',
    })
  })

  test("SendGrid's own error message surfaces", async () => {
    const fetchImpl = stubFetch({ status: 403, body: { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] } })
    await assert.rejects(
      sendEmail({ SENDGRID_API_KEY: 'SG.test' }, MESSAGE, { fetchImpl }),
      (error) => error instanceof EmailError && /verified Sender Identity/.test(error.message),
    )
  })
})

describe('Resend', () => {
  test('sends with the combined from line', async () => {
    const fetchImpl = stubFetch({ body: { id: 'email_1' } })
    const id = await sendEmail({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Land Quotient <noreply@example.com>' }, MESSAGE, {
      fetchImpl,
    })
    assert.equal(id, 'email_1')
    assert.equal(fetchImpl.calls[0].url, 'https://api.resend.com/emails')
    assert.equal(JSON.parse(fetchImpl.calls[0].init.body).from, 'Land Quotient <noreply@example.com>')
  })

  test('SendGrid wins when both keys exist', async () => {
    const fetchImpl = stubFetch({ status: 202 })
    await sendEmail({ SENDGRID_API_KEY: 'SG.test', RESEND_API_KEY: 're_test' }, MESSAGE, { fetchImpl })
    assert.ok(fetchImpl.calls[0].url.includes('sendgrid'))
  })
})

describe('failure shapes', () => {
  test('a network failure is an EmailError, never a crash', async () => {
    const failing = async () => {
      throw new TypeError('fetch failed')
    }
    await assert.rejects(
      sendEmail({ SENDGRID_API_KEY: 'SG.test' }, MESSAGE, { fetchImpl: failing }),
      (error) => error instanceof EmailError && /could not be reached/.test(error.message),
    )
  })

  test('no key at all refuses cleanly', async () => {
    await assert.rejects(sendEmail({}, MESSAGE), EmailError)
  })
})

describe('the verification email', () => {
  test('carries the link in both bodies and greets by name', () => {
    const mail = verificationEmail({ name: 'Pat', url: 'https://survey.example.com/?verify=tok' })
    assert.ok(mail.text.includes('https://survey.example.com/?verify=tok'))
    assert.ok(mail.html.includes('https://survey.example.com/?verify=tok'))
    assert.ok(mail.text.startsWith('Hi Pat,'))
  })
})
