/**
 * The AI provider layer: Anthropic, Gemini, or Grok.
 *
 * The point under test is the seams — which provider a deployment resolves
 * to, how each API's answer becomes the same fields, and that capability
 * gaps fail with instructions rather than garbage.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import {
  geminiExtract,
  grokExtract,
  normalizeFields,
  resolveProvider,
} from '../app/lib/ai.js'
import { FlyerExtractionError, isConfigured } from '../app/lib/flyer.js'
import { extractFromText } from '../app/lib/paste.js'

const ANSWER = {
  name: 'Parmer Business Park',
  address: '4100 Parmer Ln',
  city: 'Austin',
  state: 'TX',
  zip: '78727',
  rentRate: '28.5',
  rentUnit: 'psf/yr',
  sizeSqft: 3200,
  confidence: 'high',
  uncertainFields: ['nnn'],
}

describe('choosing the provider', () => {
  test('whichever key is set decides', () => {
    assert.equal(resolveProvider({}), null)
    assert.equal(resolveProvider({ ANTHROPIC_API_KEY: 'k' }), 'anthropic')
    assert.equal(resolveProvider({ GEMINI_API_KEY: 'k' }), 'gemini')
    assert.equal(resolveProvider({ XAI_API_KEY: 'k' }), 'grok')
    assert.equal(resolveProvider({ GROK_API_KEY: 'k' }), 'grok')
  })

  test('AI_PROVIDER overrides when several keys exist', () => {
    assert.equal(
      resolveProvider({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', AI_PROVIDER: 'gemini' }),
      'gemini',
    )
  })

  test('a typo in AI_PROVIDER fails loudly, not silently', () => {
    assert.throws(() => resolveProvider({ AI_PROVIDER: 'openai' }), /must be one of/)
  })

  test('any provider key counts as configured', () => {
    assert.equal(isConfigured({}), false)
    assert.equal(isConfigured({ GEMINI_API_KEY: 'k' }), true)
    assert.equal(isConfigured({ XAI_API_KEY: 'k' }), true)
  })
})

describe('normalising model output', () => {
  test('numbers arrive as numbers even when the model sent strings', () => {
    const fields = normalizeFields(ANSWER)
    assert.equal(fields.rentRate, 28.5)
    assert.equal(fields.sizeSqft, 3200)
    assert.equal(fields.nnn, null, 'a missing key is null, not undefined')
  })

  test('an invented confidence value degrades to medium', () => {
    assert.equal(normalizeFields({ ...ANSWER, confidence: 'certain!!' }).confidence, 'medium')
  })
})

describe('Gemini', () => {
  test('reads the answer out of candidates and normalises it', async () => {
    let request = null
    const fetchImpl = async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }] }),
      }
    }

    const { fields } = await geminiExtract({ text: 'listing text' }, { GEMINI_API_KEY: 'k' }, { fetchImpl })
    assert.equal(fields.name, 'Parmer Business Park')
    assert.equal(fields.rentRate, 28.5)
    assert.ok(request.url.includes('generativelanguage.googleapis.com'))
    assert.equal(request.init.headers['x-goog-api-key'], 'k')
    const body = JSON.parse(request.init.body)
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
  })

  test('a PDF rides along as inline data', async () => {
    let sent = null
    const fetchImpl = async (url, init) => {
      sent = JSON.parse(init.body)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }] }),
      }
    }
    await geminiExtract(
      { bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' },
      { GEMINI_API_KEY: 'k' },
      { fetchImpl },
    )
    assert.equal(sent.contents[0].parts[0].inline_data.mime_type, 'application/pdf')
  })

  test('a rejected key says so', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '{}' })
    await assert.rejects(
      () => geminiExtract({ text: 'x' }, { GEMINI_API_KEY: 'bad' }, { fetchImpl }),
      /Gemini API key was rejected/,
    )
  })
})

describe('Grok', () => {
  test('reads the answer out of choices, tolerating a code fence', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'grok-4',
          choices: [{ message: { content: '```json\n' + JSON.stringify(ANSWER) + '\n```' } }],
        }),
    })
    const { fields, model } = await grokExtract({ text: 'listing' }, { XAI_API_KEY: 'k' }, { fetchImpl })
    assert.equal(fields.city, 'Austin')
    assert.equal(model, 'grok-4')
  })

  test('refuses a PDF with instructions rather than mangling it', async () => {
    await assert.rejects(
      () => grokExtract({ bytes: new Uint8Array([1]), mimeType: 'application/pdf' }, { XAI_API_KEY: 'k' }),
      (error) => error instanceof FlyerExtractionError && /AI_PROVIDER/.test(error.message),
    )
  })
})

describe('pasted text through a provider', () => {
  test('a Gemini deployment reads pastes with Gemini', async () => {
    // extractFromText resolves the provider itself; the fetch stub stands in
    // for Gemini. Global fetch is restored whatever happens.
    const original = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }] }),
    })
    try {
      const result = await extractFromText('A long enough pasted listing blurb here', {
        env: { GEMINI_API_KEY: 'k' },
      })
      assert.equal(result.source, 'ai')
      assert.equal(result.fields.name, 'Parmer Business Park')
    } finally {
      globalThis.fetch = original
    }
  })
})
