// Generation's query, against the built package. Run with `npm test`.
//
// fetch is the only thing replaced: it is the network.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Normapi, generateInvoicePdf } from '../dist/index.js'

/** A business invoice: no buyer reference, no contact, no electronic addresses. */
const invoice = {
  invoiceNumber: 'SM-2026-047',
  issueDate: '2026-10-20',
  currency: 'EUR',
  seller: {
    name: 'Studio Muster Grafikdesign',
    vatId: 'DE312456789',
    address: { city: 'Freiburg im Breisgau', postcode: '79098', country: 'DE' },
  },
  buyer: {
    name: 'Beispiel Backstube GmbH',
    address: { city: 'Freiburg im Breisgau', postcode: '79104', country: 'DE' },
  },
  payment: { meansCode: '58', iban: 'DE31680501012345678901' },
  lines: [{ name: 'Logo', quantity: 1, unit: 'C62', unitPrice: '1200.00', vatCategory: 'S', vatRate: 19 }],
}

/** A fetch that answers 200 with a body and remembers what it was asked. */
function answering(body, headers = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(body, { status: 200, headers })
  }
  return { fetch, calls }
}

describe('generateInvoice', () => {
  it('asks for nothing it was not given', async () => {
    const { fetch, calls } = answering('<Invoice/>')

    await new Normapi({ fetch }).generateInvoice(invoice)

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/invoices')
  })

  it('sends the syntax and the profile', async () => {
    const { fetch, calls } = answering('<Invoice/>', {
      'X-Normapi-Scenario': 'EN16931 (CII)',
    })

    const result = await new Normapi({ fetch }).generateInvoice(invoice, {
      syntax: 'cii',
      profile: 'en16931',
    })

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/invoices?syntax=cii&profile=en16931')
    assert.equal(result.scenario, 'EN16931 (CII)')
    assert.deepEqual(result.ignoredFields, [])
  })

  it('lists the fields the service ignored', async () => {
    const { fetch } = answering('<Invoice/>', {
      'X-Normapi-Ignored-Fields': 'lines[0].articleNumber, customerNumber',
    })

    const result = await new Normapi({ fetch }).generateInvoice(invoice)

    assert.deepEqual(result.ignoredFields, ['lines[0].articleNumber', 'customerNumber'])
  })
})

describe('generateInvoicePdf', () => {
  it('stays XRechnung without a profile', async () => {
    const { fetch, calls } = answering('%PDF')

    await new Normapi({ fetch }).generateInvoicePdf(invoice)

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/invoices?syntax=zugferd')
  })

  it('makes an EN 16931 hybrid on request', async () => {
    const { fetch, calls } = answering('%PDF')

    const { pdf } = await generateInvoicePdf(invoice, { fetch, profile: 'en16931' })

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/invoices?syntax=zugferd&profile=en16931')
    assert.equal(new TextDecoder().decode(pdf), '%PDF')
  })
})
