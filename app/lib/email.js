/**
 * Outbound email, over Resend's plain HTTP API.
 *
 * No SDK — one fetch — so it runs unchanged on Cloudflare Workers. The only
 * mail this app sends is the signup verification link, and self-serve signup
 * stays closed unless sending is configured: an account that could never
 * receive its verification link should never get created.
 */

const API = 'https://api.resend.com/emails'

export function emailConfigured(env = {}) {
  return Boolean(env.RESEND_API_KEY)
}

export class EmailError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EmailError'
  }
}

/**
 * The sender line. EMAIL_FROM should name a domain verified in Resend;
 * the fallback is Resend's shared testing sender, which only delivers to
 * the account owner's own address — fine for trying it out, wrong for
 * production, so set EMAIL_FROM before opening signup.
 */
function sender(env) {
  return env.EMAIL_FROM || 'SiteSurvey CRE <onboarding@resend.dev>'
}

export async function sendEmail(env, { to, subject, html, text }, { fetchImpl = fetch } = {}) {
  if (!emailConfigured(env)) throw new EmailError('Email sending is not configured on this server.')

  let response
  try {
    response = await fetchImpl(API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: sender(env), to: [to], subject, html, text }),
    })
  } catch {
    // A network failure is the email service being unreachable, which callers
    // already know how to survive; it must not surface as a server error.
    throw new EmailError('The email service could not be reached. Try again in a moment.')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new EmailError(body?.message ?? `The email service returned HTTP ${response.status}.`)
  }
  return body?.id ?? null
}

/** The verification email, plain enough to survive any mail client. */
export function verificationEmail({ name, url }) {
  const greeting = name ? `Hi ${name},` : 'Hi,'
  return {
    subject: 'Confirm your email — SiteSurvey CRE',
    text: `${greeting}\n\nConfirm your email address to finish creating your SiteSurvey CRE account:\n\n${url}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this email and nothing happens.`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 12px;font-size:18px">Confirm your email</h2>
  <p style="margin:0 0 16px;line-height:1.5">${greeting} Confirm your email address to finish creating your SiteSurvey CRE account.</p>
  <p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Confirm email</a></p>
  <p style="margin:0 0 6px;font-size:13px;color:#475569">Or paste this link into your browser:</p>
  <p style="margin:0 0 16px;font-size:13px;word-break:break-all"><a href="${url}" style="color:#0d9488">${url}</a></p>
  <p style="margin:0;font-size:12px;color:#64748b">The link works once and expires in 24 hours. If you did not sign up, ignore this email and nothing happens.</p>
</div>`,
  }
}
