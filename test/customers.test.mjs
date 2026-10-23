// The customers of software that invoices on their behalf: the header on every
// counted call, the counts, and the ceilings. Run with `npm test`.
//
// fetch is the only thing replaced: it is the network.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CustomerQuotaExceededError,
  Normapi,
  RateLimitError,
  generateInvoice,
} from '../dist/index.js'

const invoice = {
  invoiceNumber: 'RE-2026-0815',
  issueDate: '2026-10-23',
  currency: 'EUR',
  seller: { name: 'Muster GmbH', vatId: 'DE123456789', address: { city: 'Berlin', postcode: '10115', country: 'DE' } },
  buyer: { name: 'Beispiel AG', address: { city: 'Hamburg', postcode: '20095', country: 'DE' } },
  payment: { meansCode: '58', iban: 'DE02120300000000202051' },
  lines: [{ name: 'Lizenz', quantity: 1, unit: 'C62', unitPrice: '199.00', vatCategory: 'S', vatRate: 19 }],
}

const validation = {
  acceptable: true,
  wellFormed: true,
  schemaValid: true,
  schematronValid: true,
  businessRulesEvaluated: true,
  rulesetVersion: 'v2026-01-31',
  scenario: 'EN16931 XRechnung (UBL Invoice)',
  findings: [],
}

/** A fetch that answers each call with the next response, and remembers what it was asked. */
function answering(...responses) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(calls.length, responses.length) - 1]
    return typeof next === 'function' ? next() : next
  }
  return { fetch, calls }
}

const json = (body, status = 200, headers = {}) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const xml = (headers = {}) => () => new Response('<Invoice/>', { status: 200, headers })

const page = {
  month: '2026-10',
  customers: [
    { customer: 'tenant-42', generated: 418, refused: 3, calls: { generate: 421, validate: 96 }, monthlyInvoices: 500 },
    { customer: 'tenant-7', generated: 97, refused: 0, calls: { generate: 97 }, monthlyInvoices: null },
  ],
  withoutCustomer: { generated: 12, refused: 1, calls: { generate: 13, validate: 40 } },
  nextCursor: null,
}

describe('the customer header', () => {
  it('is sent with every counted call of a client that names one', async () => {
    const { fetch, calls } = answering(xml(), json(validation), xml())
    const client = new Normapi({ fetch, apiKey: 'nk_test', customer: 'tenant-42' })

    await client.generateInvoice(invoice)
    await client.validate('<Invoice/>')
    await client.generateInvoicePdf(invoice)

    for (const call of calls) {
      assert.equal(call.init.headers['X-Normapi-Customer'], 'tenant-42')
    }
  })

  it('is not sent by a client that names none', async () => {
    const { fetch, calls } = answering(xml())

    await new Normapi({ fetch, apiKey: 'nk_test' }).generateInvoice(invoice)

    assert.equal('X-Normapi-Customer' in calls[0].init.headers, false)
  })

  it('takes the call’s own customer over the client’s, and null for none', async () => {
    const { fetch, calls } = answering(xml(), xml())
    const client = new Normapi({ fetch, apiKey: 'nk_test', customer: 'tenant-42' })

    await client.generateInvoice(invoice, { customer: 'tenant-7' })
    await client.generateInvoice(invoice, { customer: null })

    assert.equal(calls[0].init.headers['X-Normapi-Customer'], 'tenant-7')
    assert.equal('X-Normapi-Customer' in calls[1].init.headers, false)
  })

  it('reaches the one-shot functions too', async () => {
    const { fetch, calls } = answering(xml({ 'X-Normapi-Customer': 'tenant-42' }))

    const result = await generateInvoice(invoice, { fetch, apiKey: 'nk_test', customer: 'tenant-42' })

    assert.equal(calls[0].init.headers['X-Normapi-Customer'], 'tenant-42')
    assert.equal(result.customer, 'tenant-42')
  })

  it('reads the customer and its ceiling off a generation', async () => {
    const { fetch } = answering(
      xml({
        'X-Normapi-Customer': 'tenant-42',
        'X-Normapi-Customer-Used': '418',
        'X-Normapi-Customer-Limit': '500',
      }),
      xml(),
    )
    const client = new Normapi({ fetch, apiKey: 'nk_test', customer: 'tenant-42' })

    const capped = await client.generateInvoice(invoice)
    const plain = await client.generateInvoice(invoice)

    assert.equal(capped.customer, 'tenant-42')
    assert.deepEqual(capped.customerQuota, { used: 418, limit: 500 })
    assert.equal(plain.customer, null)
    assert.equal(plain.customerQuota, null)
  })
})

describe('a customer at its ceiling', () => {
  it('is its own error, not a rate limit to wait out', async () => {
    const { fetch } = answering(
      json(
        {
          type: 'https://normapi.de/problems/customer-quota-exceeded',
          title: 'Monthly ceiling for this customer reached',
          status: 429,
          detail: 'Customer tenant-42 generated its 500 invoices of this month.',
          customer: 'tenant-42',
          used: 500,
          limit: 500,
          resetsAt: '2026-11-01T00:00:00Z',
        },
        429,
        { 'Retry-After': '736000' },
      ),
    )

    const error = await new Normapi({ fetch, apiKey: 'nk_test', customer: 'tenant-42' })
      .generateInvoice(invoice)
      .catch((thrown) => thrown)

    assert.ok(error instanceof CustomerQuotaExceededError)
    assert.equal(error instanceof RateLimitError, false)
    assert.equal(error.status, 429)
    assert.equal(error.customer, 'tenant-42')
    assert.equal(error.used, 500)
    assert.equal(error.limit, 500)
    assert.equal(error.resetsAt?.toISOString(), '2026-11-01T00:00:00.000Z')
    assert.equal(error.retryAfterSeconds, 736000)
  })

  it('leaves the per-minute 429 a RateLimitError', async () => {
    const { fetch } = answering(
      json({ type: 'https://normapi.de/problems/rate-limited', title: 'Too many requests', status: 429 }, 429, {
        'Retry-After': '3',
      }),
    )

    const error = await new Normapi({ fetch, apiKey: 'nk_test' }).generateInvoice(invoice).catch((thrown) => thrown)

    assert.ok(error instanceof RateLimitError)
    assert.equal(error.retryAfterSeconds, 3)
  })
})

describe('listCustomers', () => {
  it('reads a page, sending the month, the page size and the cursor', async () => {
    const { fetch, calls } = answering(json(page))

    const result = await new Normapi({ fetch, apiKey: 'nk_test' }).listCustomers({
      month: '2026-10',
      limit: 2,
      cursor: 'NDE4OnRlbmFudC00Mg',
    })

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/customers?month=2026-10&limit=2&cursor=NDE4OnRlbmFudC00Mg')
    assert.equal(calls[0].init.method, 'GET')
    assert.deepEqual(result, page)
  })

  it('never names a customer in the header, whatever the client names', async () => {
    const { fetch, calls } = answering(json(page))

    await new Normapi({ fetch, apiKey: 'nk_test', customer: 'tenant-42' }).listCustomers()

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/customers')
    assert.equal('X-Normapi-Customer' in calls[0].init.headers, false)
    assert.equal(calls[0].init.headers['Authorization'], 'Bearer nk_test')
  })

  it('refuses a body that is not a page', async () => {
    const { fetch } = answering(json({ month: '2026-10', customers: [{ customer: 'x' }] }))

    await assert.rejects(new Normapi({ fetch, apiKey: 'nk_test' }).listCustomers(), /unexpected response shape/)
  })

  it('walks every page with customers()', async () => {
    const first = { ...page, customers: [page.customers[0]], nextCursor: 'b' }
    const second = { ...page, customers: [page.customers[1]], nextCursor: null }
    const { fetch, calls } = answering(json(first), json(second))

    const all = []
    for await (const customer of new Normapi({ fetch, apiKey: 'nk_test' }).customers({ month: '2026-10' })) {
      all.push(customer.customer)
    }

    assert.deepEqual(all, ['tenant-42', 'tenant-7'])
    assert.equal(calls[1].url, 'https://api.normapi.de/v1/customers?month=2026-10&cursor=b')
  })

  it('stops when the service hands the same cursor back', async () => {
    const looping = { ...page, nextCursor: 'same' }
    const { fetch, calls } = answering(json(looping))

    let count = 0
    for await (const _ of new Normapi({ fetch, apiKey: 'nk_test' }).customers()) count++

    assert.equal(calls.length, 2)
    assert.equal(count, 4)
  })

  it('throws the service’s refusal with its detail', async () => {
    const { fetch } = answering(
      json(
        {
          type: 'https://normapi.de/problems/account-required',
          title: 'Key without an account',
          status: 403,
          detail: 'Customers belong to an account, and this key has none.',
        },
        403,
      ),
    )

    const error = await new Normapi({ fetch, apiKey: 'nk_test' }).listCustomers().catch((thrown) => thrown)

    assert.equal(error.status, 403)
    assert.match(error.detail, /belong to an account/)
  })
})

describe('one customer and its ceiling', () => {
  it('reads one customer, the reference encoded into the path', async () => {
    const { fetch, calls } = answering(json(page.customers[0]))

    const result = await new Normapi({ fetch, apiKey: 'nk_test' }).getCustomer('tenant:42', { month: '2026-09' })

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/customers/tenant%3A42?month=2026-09')
    assert.equal(result.generated, 418)
  })

  it('sets a ceiling', async () => {
    const { fetch, calls } = answering(json({ customer: 'tenant-42', monthlyInvoices: 500 }))

    const result = await new Normapi({ fetch, apiKey: 'nk_test' }).setCustomerAllowance('tenant-42', 500)

    assert.equal(calls[0].url, 'https://api.normapi.de/v1/customers/tenant-42/allowance')
    assert.equal(calls[0].init.method, 'PUT')
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
    assert.equal(calls[0].init.body, JSON.stringify({ monthlyInvoices: 500 }))
    assert.deepEqual(result, { customer: 'tenant-42', monthlyInvoices: 500 })
  })

  it('removes a ceiling on a 204', async () => {
    const { fetch, calls } = answering(() => new Response(null, { status: 204 }))

    await new Normapi({ fetch, apiKey: 'nk_test' }).clearCustomerAllowance('tenant-42')

    assert.equal(calls[0].init.method, 'DELETE')
    assert.equal(calls[0].init.body, undefined)
  })

  it('throws when a customer’s own key tries to move its ceiling', async () => {
    const { fetch } = answering(
      json(
        {
          type: 'https://normapi.de/problems/customer-bound-key',
          title: 'Not permitted with a customer’s key',
          status: 403,
          detail: "A customer's own key cannot change a ceiling.",
        },
        403,
      ),
    )

    const error = await new Normapi({ fetch, apiKey: 'nk_bound' })
      .setCustomerAllowance('tenant-42', 1000)
      .catch((thrown) => thrown)

    assert.equal(error.status, 403)
    assert.match(error.detail, /cannot change a ceiling/)
  })
})
