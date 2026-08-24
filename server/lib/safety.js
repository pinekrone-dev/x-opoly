/**
 * The crawler fetches URLs supplied by whoever is using the tool, so the server
 * has to refuse targets that point back at its own network. Without this a
 * hosted deployment is an open SSRF proxy into the private subnet.
 *
 * Set ALLOW_PRIVATE_HOSTS=1 to disable the guard for local development.
 */

import { lookup } from 'node:dns/promises'
import net from 'node:net'

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.goog',
])

function ipv4ToInt(address) {
  return address.split('.').reduce((total, part) => (total << 8) + Number(part), 0) >>> 0
}

const BLOCKED_V4_RANGES = [
  ['0.0.0.0', 8],       // "this network"
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local, includes cloud metadata
  ['172.16.0.0', 12],   // private
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.168.0.0', 16],  // private
  ['198.18.0.0', 15],   // benchmarking
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }))

export function isPrivateAddress(address) {
  const version = net.isIP(address)
  if (version === 4) {
    const value = ipv4ToInt(address)
    return BLOCKED_V4_RANGES.some((range) => (value & range.mask) >>> 0 === range.base)
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return true
    if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    // IPv4-mapped addresses such as ::ffff:127.0.0.1
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    return false
  }
  return false
}

export function allowPrivateHosts() {
  return process.env.ALLOW_PRIVATE_HOSTS === '1'
}

/**
 * Resolves the hostname of `url` and throws when it points somewhere the
 * server must not reach.
 */
export async function assertPublicUrl(url) {
  if (allowPrivateHosts()) return

  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    throw new Error('That URL could not be parsed.')
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Crawling internal or loopback hosts is not allowed.')
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Crawling private IP addresses is not allowed.')
    return
  }

  let records
  try {
    records = await lookup(hostname, { all: true })
  } catch {
    throw new Error(`The hostname "${hostname}" could not be resolved.`)
  }

  if (records.length === 0) throw new Error(`The hostname "${hostname}" could not be resolved.`)
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('That hostname resolves to a private address, which is not allowed.')
  }
}
