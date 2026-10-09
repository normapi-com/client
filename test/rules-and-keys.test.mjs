// Rule lookups and the API key, against the built package. Run with `npm test`.
//
// fetch is the only thing replaced: it is the network.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NormapiError, Normapi, RateLimitError, explainRule } from '../dist/index.js'

const explanation = {
  meaning: 'Every XRechnung needs a buyer reference in BT-10.',
  cause: 'It is usually missing because the buyer never sent one.',
  fix: 'Enter the Leitweg-ID or the reference the buyer gave you.',
  url: 'https://normapi.com/en/errors/br-de-15',
}

/** A fetch that answers with one JSON body and remembers what it was asked. */
function answering(status, body, headers = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  }
  return { fetch, calls }
}

describe('explainRule', () => {
  it('asks for the rule by its code and returns the explanation', async () => {
    const { fetch, calls } = answering(200, { code: 'BR-DE-15', language: 'en', explanation })

    const info = await new Normapi({ fetch }).explainRule('br-de-15')

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/rules/br-de-15')
    assert.equal(calls[0].init.method, 'GET')
    assert.deepEqual(info, { code: 'BR-DE-15', language: 'en', explanation })
  })

  it('escapes the code into the path', async () => {
    const { fetch, calls } = answering(200, { code: 'BR-DE-15', language: 'en', explanation })

    await new Normapi({ fetch }).explainRule(' BR/../x ')

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/rules/BR%2F..%2Fx')
  })

  it('resolves to null for a code no rule has', async () => {
    const { fetch } = answering(404, { detail: 'No explained rule has the code cvc-x.' })

    assert.equal(await explainRule('cvc-x', { fetch }), null)
  })

  it('throws on a shape it cannot verify', async () => {
    const { fetch } = answering(200, { code: 'BR-DE-15', language: 'fr', explanation })

    await assert.rejects(new Normapi({ fetch }).explainRule('BR-DE-15'), NormapiError)
  })

  it('refuses an explanation whose link is not https', async () => {
    const { fetch } = answering(200, {
      code: 'BR-DE-15',
      language: 'en',
      explanation: { ...explanation, url: 'javascript:alert(1)' },
    })

    await assert.rejects(new Normapi({ fetch }).explainRule('BR-DE-15'), NormapiError)
  })

  it('reports a rate limit as such', async () => {
    const { fetch } = answering(429, { detail: 'slow down' }, { 'Retry-After': '12' })

    await assert.rejects(new Normapi({ fetch }).explainRule('BR-DE-15'), (error) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfterSeconds, 12)
      return true
    })
  })
})

describe('apiKey', () => {
  it('is sent as a Bearer token', async () => {
    const { fetch, calls } = answering(200, { code: 'BR-DE-15', language: 'en', explanation })

    await new Normapi({ fetch, apiKey: 'nk_live_abc' }).explainRule('BR-DE-15')

    assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer nk_live_abc')
  })

  it('reaches the one-shot helpers too', async () => {
    const { fetch, calls } = answering(200, { code: 'BR-DE-15', language: 'en', explanation })

    await explainRule('BR-DE-15', { fetch, apiKey: 'nk_live_abc' })

    assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer nk_live_abc')
  })

  it('is absent when none is configured', async () => {
    const { fetch, calls } = answering(200, { code: 'BR-DE-15', language: 'en', explanation })

    await new Normapi({ fetch }).explainRule('BR-DE-15')

    assert.equal(new Headers(calls[0].init.headers).get('Authorization'), null)
  })
})
