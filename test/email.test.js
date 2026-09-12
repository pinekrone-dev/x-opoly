/**
 * The email layer: SendGrid and Resend behind one sendEmail, with the sender
 * line parsed once and network failures translated into the survivable error.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import {
  DEFAULT_SENDER,
  EmailError,
  allowedSender,
  emailConfigured,
  sendEmail,
  verificationEmail,
} from '../app/lib/email.js'

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

// The sender rule only accepts addresses on the deployment's own domain,
// so a test that sends from example.com has to say that is its domain.
const ON_EXAMPLE = { EMAIL_DOMAIN: 'example.com' }

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
    await sendEmail(
      { ...ON_EXAMPLE, SENDGRID_API_KEY: 'SG.test', EMAIL_FROM: 'Land Quotient <noreply@example.com>' },
      MESSAGE,
      { fetchImpl },
    )

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
    await sendEmail({ ...ON_EXAMPLE, SENDGRID_API_KEY: 'SG.test', EMAIL_FROM: 'hello@example.com' }, MESSAGE, {
      fetchImpl,
    })
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
    const id = await sendEmail({ ...ON_EXAMPLE, RESEND_API_KEY: 're_test', EMAIL_FROM: 'Land Quotient <noreply@example.com>' }, MESSAGE, {
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

describe('who transactional mail comes from', () => {
  /*
   * The rule this guards, in Kevin's words on 12 September 2026: the sender
   * must never be his own address, always something generic, with Marc the
   * other option. A personal sender on automated mail invites replies into a
   * human inbox and hands that address to everyone who signs up.
   */
  const from = async (env) => {
    const fetchImpl = stubFetch({ status: 202, body: {} })
    await sendEmail({ SENDGRID_API_KEY: 'SG.test', ...env }, MESSAGE, { fetchImpl })
    return JSON.parse(fetchImpl.calls[0].init.body).from
  }

  test('an unconfigured deployment sends from the no-reply address', async () => {
    assert.deepEqual(await from({}), { name: 'Land Quotient', email: DEFAULT_SENDER })
  })

  test('a function address on the product domain is kept', async () => {
    assert.equal((await from({ EMAIL_FROM: 'marc@landquotient.com' })).email, 'marc@landquotient.com')
    assert.equal((await from({ EMAIL_FROM: 'support@landquotient.com' })).email, 'support@landquotient.com')
  })

  test('a personal address is refused however it is spelled', async () => {
    for (const raw of [
      'kevin@landquotient.com',
      'Kevin Krone <kevin@landquotient.com>',
      'kevin.krone@landquotient.com',
      'kevin-krone@landquotient.com',
      'kkrone@landquotient.com',
      'KEVIN@LANDQUOTIENT.COM',
    ]) {
      const sender = await from({ EMAIL_FROM: raw })
      assert.equal(sender.email, DEFAULT_SENDER, `${raw} must not be the sender`)
      assert.equal(sender.name, 'Land Quotient')
    }
  })

  test('an address on any other domain is refused', async () => {
    for (const raw of ['kevin@realestateaistudio.com', 'pinekrone@gmail.com', 'hello@example.com']) {
      assert.equal((await from({ EMAIL_FROM: raw })).email, DEFAULT_SENDER, `${raw} must not be the sender`)
    }
  })

  test('a deployment may name its own domain', () => {
    assert.equal(allowedSender('noreply@example.com', { EMAIL_DOMAIN: 'example.com' }), true)
    assert.equal(allowedSender('kevin@example.com', { EMAIL_DOMAIN: 'example.com' }), false)
    assert.equal(allowedSender('noreply@landquotient.com', { EMAIL_DOMAIN: 'example.com' }), false)
  })

  test('a malformed address is refused rather than sent', () => {
    for (const raw of ['', '   ', 'not-an-address', '@landquotient.com', 'noreply@', undefined, null]) {
      assert.equal(allowedSender(raw), false, `${String(raw)} must not be a sender`)
    }
  })
})
