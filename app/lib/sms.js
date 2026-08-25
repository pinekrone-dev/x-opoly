/**
 * Sending the second-factor code by text.
 *
 * Twilio's REST API over plain fetch — no SDK, because the SDK is a Node
 * library and this has to run on Workers, and the call is one form POST.
 *
 * Nothing here logs the code or the destination number. A verification code in
 * a log line is a verification code an operator can read.
 */

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01/Accounts'

export class SmsUnavailable extends Error {
  constructor(message, { configured = true } = {}) {
    super(message)
    this.name = 'SmsUnavailable'
    this.configured = configured
  }
}

export function smsConfigured(env = {}) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER)
}

function basicAuth(sid, token) {
  return `Basic ${btoa(`${sid}:${token}`)}`
}

/**
 * @param {string} to    E.164 destination
 * @param {string} body  the message text
 */
export async function sendSms(to, body, { env = {}, fetchImpl = fetch, timeout = 10000 } = {}) {
  if (!smsConfigured(env)) {
    throw new SmsUnavailable(
      'Texting a code needs Twilio configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER on the server.',
      { configured: false },
    )
  }
  if (!to) throw new SmsUnavailable('That account has no phone number to text.')

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null

  try {
    const response = await fetchImpl(
      `${TWILIO_BASE}/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: 'POST',
        signal: controller?.signal,
        headers: {
          authorization: basicAuth(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body }).toString(),
      },
    )

    if (response.status === 401 || response.status === 403) {
      throw new SmsUnavailable('Twilio rejected the credentials. Check the SID and auth token.', {
        configured: false,
      })
    }

    if (!response.ok) {
      // Twilio explains itself well; pass its message through rather than
      // inventing one, but keep it short and never echo the destination.
      const detail = await response.json().catch(() => null)
      throw new SmsUnavailable(
        detail?.message
          ? `The text could not be sent (${String(detail.message).slice(0, 160)}).`
          : `The text could not be sent (Twilio returned HTTP ${response.status}).`,
      )
    }

    return { sent: true }
  } catch (error) {
    if (error instanceof SmsUnavailable) throw error
    if (error?.name === 'AbortError') throw new SmsUnavailable('Texting the code timed out.')
    throw new SmsUnavailable(`The text could not be sent (${error.message}).`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The message a person actually receives. */
export function codeMessage(code, appName = 'Land Quotient') {
  return `${code} is your ${appName} sign-in code. It expires in 10 minutes. If you did not try to sign in, change your password.`
}
