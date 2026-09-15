/**
 * Outbound email, over plain HTTP — SendGrid or Resend, whichever key the
 * deployment holds.
 *
 * No SDK — one fetch — so it runs unchanged on Cloudflare Workers. The only
 * mail this app sends is the signup verification link, and self-serve signup
 * stays closed unless sending is configured: an account that could never
 * receive its verification link should never get created.
 */

export function emailConfigured(env = {}) {
  return Boolean(env.SENDGRID_API_KEY || env.RESEND_API_KEY)
}

export class EmailError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EmailError'
  }
}

/*
 * Who transactional mail may come from, and who it may never come from.
 *
 * Never a person. This mail is sent by the product to a stranger who just
 * typed their address into a signup form. A personal sender puts a human
 * inbox behind an automated message: replies land somewhere nobody is
 * watching, the address is handed to everyone who ever signs up, and the
 * domain's reputation for this mail gets tied to mail that person also
 * sends by hand.
 *
 * So the sender is not simply trusted from configuration. EMAIL_FROM may
 * choose any non-personal address on the product's own domain, and anything
 * else is refused and replaced with the no-reply default. A deployment
 * misconfigured with an owner's address therefore sends from no-reply; it
 * never sends as a person.
 *
 * EMAIL_DOMAIN overrides the domain for a deployment that sends from
 * somewhere else. Whatever it is, the provider must have it authenticated —
 * a SendGrid authenticated domain or a Resend verified domain — or the send
 * bounces at the provider.
 */
export const DEFAULT_SENDER = 'noreply@landquotient.com'
const DEFAULT_SENDER_NAME = 'Land Quotient'

/*
 * Local parts that name a human rather than a function.
 *
 * Matched on the local part alone, so it holds whatever the domain is, and
 * it catches the decorated forms a config edit tends to produce: kevin,
 * kevin.krone, kevin-krone, kevinkrone, kkrone. Function addresses that
 * happen to contain a name are not the risk here; a bare first name is.
 */
const PERSONAL = /^(kevin|kkrone|krone|pinekrone)([._+-]?[a-z]*)*$/i

/** Whether an address is one this product may send transactional mail as. */
export function allowedSender(email, env = {}) {
  const at = String(email || '').trim().toLowerCase()
  const parts = at.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  const domain = String(env.EMAIL_DOMAIN || DEFAULT_SENDER.split('@')[1]).toLowerCase()
  if (parts[1] !== domain) return false
  return !PERSONAL.test(parts[0])
}

/**
 * The sender, split into address and display name.
 *
 * EMAIL_FROM accepts either `Name <address>` or a bare address. An address
 * the rule above refuses is dropped for the no-reply default rather than
 * used, because sending as a person is worse than sending as the wrong
 * mailbox.
 */
function sender(env) {
  const raw = String(env.EMAIL_FROM || `${DEFAULT_SENDER_NAME} <${DEFAULT_SENDER}>`)
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  const email = (match ? match[2] : raw).trim()
  const name = (match && match[1]) || DEFAULT_SENDER_NAME
  if (!allowedSender(email, env)) return { name: DEFAULT_SENDER_NAME, email: DEFAULT_SENDER }
  return { name, email }
}

/** One fetch, with a network failure translated into the survivable error. */
async function post(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init)
  } catch {
    // A network failure is the email service being unreachable, which callers
    // already know how to survive; it must not surface as a server error.
    throw new EmailError('The email service could not be reached. Try again in a moment.')
  }
}

async function viaSendgrid(env, { to, subject, html, text }, fetchImpl) {
  const from = sender(env)
  const response = await post(fetchImpl, 'https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from,
      subject,
      // SendGrid insists text/plain comes before text/html.
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new EmailError(body?.errors?.[0]?.message ?? `The email service returned HTTP ${response.status}.`)
  }
  return response.headers.get('x-message-id') ?? 'sent'
}

async function viaResend(env, { to, subject, html, text }, fetchImpl) {
  const from = sender(env)
  const response = await post(fetchImpl, 'https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [to], subject, html, text }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new EmailError(body?.message ?? `The email service returned HTTP ${response.status}.`)
  }
  return body?.id ?? null
}

export async function sendEmail(env, message, { fetchImpl = fetch } = {}) {
  if (env.SENDGRID_API_KEY) return viaSendgrid(env, message, fetchImpl)
  if (env.RESEND_API_KEY) return viaResend(env, message, fetchImpl)
  throw new EmailError('Email sending is not configured on this server.')
}

/** The verification email, plain enough to survive any mail client. */
export function verificationEmail({ name, url }) {
  const greeting = name ? `Hi ${name},` : 'Hi,'
  return {
    subject: 'Confirm your email — Land Quotient',
    text: `${greeting}\n\nConfirm your email address to finish creating your Land Quotient account:\n\n${url}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this email and nothing happens.`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
  <p style="margin:0 0 18px;font-size:16px;font-weight:700;letter-spacing:-0.01em"><span style="color:#1B3668">Land</span><span style="color:#12AEB6"> Quotient</span></p>
  <h2 style="margin:0 0 12px;font-size:18px">Confirm your email</h2>
  <p style="margin:0 0 16px;line-height:1.5">${greeting} Confirm your email address to finish creating your Land Quotient account.</p>
  <p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#12AEB6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Confirm email</a></p>
  <p style="margin:0 0 6px;font-size:13px;color:#475569">Or paste this link into your browser:</p>
  <p style="margin:0 0 16px;font-size:13px;word-break:break-all"><a href="${url}" style="color:#12AEB6">${url}</a></p>
  <p style="margin:0;font-size:12px;color:#64748b">The link works once and expires in 24 hours. If you did not sign up, ignore this email and nothing happens.</p>
</div>`,
  }
}

/**
 * The password reset email.
 *
 * It says plainly that ignoring it leaves the password alone, because the
 * person most likely to receive one they did not ask for is someone whose
 * address a stranger typed into the form. That sentence is the difference
 * between a worrying email and a harmless one.
 */
export function passwordResetEmail({ name, url }) {
  const greeting = name ? `Hi ${name},` : 'Hi,'
  return {
    subject: 'Reset your password — Land Quotient',
    text: `${greeting}\n\nSomeone asked to reset the password on your Land Quotient account. Choose a new one here:\n\n${url}\n\nThe link works once and expires in an hour. If you did not ask for this, ignore this email: your password stays as it is and nobody can use the link without your inbox.`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
  <p style="margin:0 0 18px;font-size:16px;font-weight:700;letter-spacing:-0.01em"><span style="color:#1B3668">Land</span><span style="color:#12AEB6"> Quotient</span></p>
  <h2 style="margin:0 0 12px;font-size:18px">Reset your password</h2>
  <p style="margin:0 0 16px;line-height:1.5">${greeting} Someone asked to reset the password on your Land Quotient account. Choose a new one:</p>
  <p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#12AEB6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Choose a new password</a></p>
  <p style="margin:0 0 6px;font-size:13px;color:#475569">Or paste this link into your browser:</p>
  <p style="margin:0 0 16px;font-size:13px;word-break:break-all"><a href="${url}" style="color:#12AEB6">${url}</a></p>
  <p style="margin:0;font-size:12px;color:#64748b">The link works once and expires in an hour. If you did not ask for this, ignore this email: your password stays as it is.</p>
</div>`,
  }
}
