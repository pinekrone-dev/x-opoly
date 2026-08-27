/**
 * GitHub Actions OIDC verification, for the ingest endpoint.
 *
 * The parcel pipeline needs to publish hundreds of megabytes into R2, and
 * every credential-shaped way of allowing that puts a long-lived secret
 * somewhere — a repo secret, a dashboard variable — that has to be minted,
 * stored, rotated and one day leaked. GitHub already solves this: every
 * Actions run can mint a short-lived JWT signed by GitHub that states, with
 * a verifiable signature, exactly which repository is running. Verifying
 * that token here means the pipeline authenticates as itself, forever, with
 * nothing stored on either side.
 *
 * Verification is deliberately strict and boring: RS256 only, GitHub's
 * issuer only, an audience this app names, a repository allowlist, and the
 * signature checked against GitHub's published keys. Anything else is a 401.
 */

const ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS_URL = `${ISSUER}/.well-known/jwks`

/** Base64url, as the JWT spec uses it — no padding, URL alphabet. */
function fromB64url(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function claimsFrom(part) {
  return JSON.parse(new TextDecoder().decode(fromB64url(part)))
}

/**
 * GitHub's signing keys, cached per isolate.
 *
 * An unknown kid forces one refetch — GitHub rotates keys, and a token
 * signed minutes after a rotation must not fail on a stale cache.
 */
let cache = { keys: null, at: 0 }

async function signingKeys(fetchImpl, kid) {
  const fresh = cache.keys && Date.now() - cache.at < 60 * 60 * 1000
  const cached = fresh ? cache.keys.find((k) => k.kid === kid) : null
  if (cached) return cache.keys
  const response = await fetchImpl(JWKS_URL)
  if (!response.ok) throw new Error(`GitHub's signing keys could not be fetched (${response.status}).`)
  const body = await response.json()
  if (!Array.isArray(body?.keys)) throw new Error("GitHub's signing keys came back unreadable.")
  cache = { keys: body.keys, at: Date.now() }
  return cache.keys
}

/** For tests: a stale or poisoned cache must not outlive one run. */
export function resetKeyCache() {
  cache = { keys: null, at: 0 }
}

/**
 * Verifies an Actions OIDC token and returns its claims.
 *
 * @param token         the raw JWT
 * @param audience      the audience this app minted the trust for
 * @param repositories  the exact owner/repo values allowed to publish
 * @throws on any defect — the caller answers 401 with the message
 */
export async function verifyActionsToken(
  token,
  { audience, repositories = [], fetchImpl = fetch, now = () => Date.now() } = {},
) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('no OIDC token was presented')
  }
  const [rawHeader, rawPayload, rawSignature] = parts

  let header, claims
  try {
    header = claimsFrom(rawHeader)
    claims = claimsFrom(rawPayload)
  } catch {
    throw new Error('the token could not be decoded')
  }

  if (header.alg !== 'RS256') throw new Error(`the token uses ${header.alg}, not RS256`)
  if (claims.iss !== ISSUER) throw new Error('the token was not issued by GitHub Actions')

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(audience)) throw new Error('the token was minted for a different audience')

  const t = now() / 1000
  // Thirty seconds of skew: runners and edges disagree about the time by
  // less than that, and a wider window just extends a stolen token's life.
  if (!(Number(claims.exp) > t - 30)) throw new Error('the token has expired')
  if (Number(claims.nbf) > t + 30) throw new Error('the token is not valid yet')

  if (!repositories.includes(claims.repository)) {
    throw new Error(`repository ${claims.repository ?? '(none)'} is not allowed to publish`)
  }

  const keys = await signingKeys(fetchImpl, header.kid)
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('the token names a signing key GitHub does not publish')

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromB64url(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  )
  if (!valid) throw new Error('the token signature does not verify')

  return claims
}
