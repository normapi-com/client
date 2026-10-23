// Reading invoices, against the built package. Run with `npm test`.
//
// fetch is the only thing replaced: it is the network. The bodies it answers
// with are real responses of POST /v1/parse — the sample library's credit
// note, direct debit, card payment, discounts, freight, delivery address,
// attachment and article numbers, the KoSIT sample with its verdict, and a
// ZUGFeRD PDF — captured from the service, so the shape checked here is the
// one it sends.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { NormapiError, Normapi, parse } from '../dist/index.js'

const responses = JSON.parse(
  readFileSync(new URL('./fixtures/parse-responses.json', import.meta.url), 'utf8'),
)

/** A fetch that answers with one JSON body and remembers what it was asked. */
function answering(status, body) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetch, calls }
}

/** A deep copy with one change, for the shapes the service must never send. */
function altered(response, change) {
  const copy = structuredClone(response)
  change(copy)
  return copy
}

describe('parse', () => {
  it('accepts every real response, unchanged', async () => {
    for (const [name, response] of Object.entries(responses)) {
      const { fetch } = answering(200, response)
      const result = await new Normapi({ fetch }).parse('<Invoice/>')
      assert.deepEqual(result, response, name)
    }
  })

  it('posts the document and asks for no verdict unless told to', async () => {
    const { fetch, calls } = answering(200, responses['21-kartenzahlung-cii'])

    const result = await new Normapi({ fetch, language: 'de' }).parse('<Invoice/>')

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/parse')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.body, '<Invoice/>')
    assert.equal(calls[0].init.headers['Accept-Language'], 'de')
    assert.equal(result.validation, null)
    assert.equal(result.invoice.payment.card.number, '4821')
    assert.equal(result.invoice.payment.card.network, null)
  })

  it('asks for the verdict on request and reads it as validate() would', async () => {
    const { fetch, calls } = answering(200, responses['kosit-ubl-validate'])

    const result = await parse(new TextEncoder().encode('<Invoice/>'), { fetch, validate: true })

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/parse?validate=true')
    assert.equal(result.validation.acceptable, true)
    assert.equal(result.validation.findings[0].code, 'BR-DE-TMP-32')
    assert.deepEqual(result.notMapped.map((entry) => entry.count), [1, 1])
  })

  it('keeps the stated amounts as the document wrote them', async () => {
    const { fetch } = answering(200, responses['24-rechnungsrabatt-cii'])

    const { invoice, stated } = await new Normapi({ fetch }).parse('<Invoice/>')

    assert.equal(typeof stated.grossTotal, 'string')
    assert.equal(stated.allowances.length, invoice.allowances.length)
    assert.equal(stated.lines.length, invoice.lines.length)
  })

  it('says which file of a PDF it read', async () => {
    const { fetch } = answering(200, responses['zugferd-01'])

    const { source, syntax } = await new Normapi({ fetch }).parse(new Uint8Array([0x25]))

    assert.deepEqual(source, { kind: 'pdf', attachment: 'xrechnung.xml' })
    assert.equal(syntax, 'cii')
  })

  it('sends a parsed invoice back to generation as it came', async () => {
    const parsed = answering(200, responses['33-innergemeinschaftliche-lieferung-cii'])
    const { invoice, profile } = await new Normapi({ fetch: parsed.fetch }).parse('<Invoice/>')
    const generated = []
    const fetch = async (url, init) => {
      generated.push({ url, init })
      return new Response('<Invoice/>', { status: 200 })
    }

    await new Normapi({ fetch }).generateInvoice(invoice, { syntax: 'cii', profile: profile ?? undefined })

    assert.equal(generated[0].url, 'https://api.normapi.de/v1/invoices?syntax=cii&profile=xrechnung')
    assert.deepEqual(JSON.parse(generated[0].init.body), invoice)
  })

  it('refuses a response of another shape rather than guess', async () => {
    const card = responses['21-kartenzahlung-cii']
    const broken = {
      'an amount as a string': altered(card, (r) => {
        r.invoice.lines[0].unitPrice = '95.00'
      }),
      'a missing field': altered(card, (r) => {
        delete r.invoice.seller.address.country
      }),
      'a stated amount as a number': altered(card, (r) => {
        r.stated.grossTotal = 336.9
      }),
      'an unknown syntax': altered(card, (r) => {
        r.syntax = 'zugferd'
      }),
      'a count that is no integer': altered(responses['kosit-ubl-validate'], (r) => {
        r.notMapped[0].count = 1.5
      }),
      'a verdict of another shape': altered(responses['kosit-ubl-validate'], (r) => {
        r.validation.acceptable = 'yes'
      }),
    }
    for (const [name, body] of Object.entries(broken)) {
      const { fetch } = answering(200, body)
      await assert.rejects(new Normapi({ fetch }).parse('<Invoice/>'), NormapiError, name)
    }
  })

  it('tolerates a field it does not know', async () => {
    const body = altered(responses['21-kartenzahlung-cii'], (r) => {
      r.invoice.lines[0].somethingNew = 'later'
    })
    const { fetch } = answering(200, body)

    const result = await new Normapi({ fetch }).parse('<Invoice/>')

    assert.equal(result.invoice.lines[0].name, body.invoice.lines[0].name)
  })

  it('passes on why a document is no invoice', async () => {
    const { fetch } = answering(422, {
      type: 'https://normapi.de/problems/invalid-document',
      title: 'Document could not be processed',
      status: 422,
      detail:
        'The root element is project (http://maven.apache.org/POM/4.0.0). An e-invoice is a UBL Invoice, a UBL CreditNote or a CII CrossIndustryInvoice.',
    })

    await assert.rejects(new Normapi({ fetch }).parse('<project/>'), (error) => {
      assert.ok(error instanceof NormapiError)
      assert.equal(error.status, 422)
      assert.match(error.detail, /root element is project/)
      return true
    })
  })
})
