// Explanations on findings, against the built package. Run with `npm test`.
//
// fetch is the only thing replaced: it is the network. Everything this package
// does on its side of it — the headers it sends, the parsing of what comes
// back — is what is under test.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvoiceNotPermittedError, NormapiError, Normapi, validate } from '../dist/index.js'

const explanation = {
  meaning: 'Der Zahlbetrag (BT-115) muss rechnerisch aufgehen.',
  cause: 'Gleitkomma-Arithmetik im Quellsystem.',
  fix: 'Rechnen Sie Beträge durchgängig mit Dezimalarithmetik.',
  url: 'https://normapi.de/fehler/br-co-16',
}

const finding = {
  code: 'BR-CO-16',
  severity: 'ERROR',
  text: '[BR-CO-16]-Amount due for payment (BT-115) = ...',
  origin: 'SCHEMATRON',
  location: '/Q{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice[1]',
  line: null,
  column: null,
  test: null,
  explanation,
}

function result(findings) {
  return {
    acceptable: false,
    wellFormed: true,
    schemaValid: true,
    schematronValid: false,
    businessRulesEvaluated: true,
    rulesetVersion: 'v2026-08-31',
    scenario: 'EN16931 XRechnung (UBL Invoice)',
    findings,
  }
}

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

describe('explanations', () => {
  it('asks for the configured language', async () => {
    const { fetch, calls } = answering(200, result([finding]))

    await new Normapi({ fetch, language: 'de' }).validate('<Invoice/>')

    assert.equal(new Headers(calls[0].init.headers).get('Accept-Language'), 'de')
  })

  it('passes the language through the one-shot validate()', async () => {
    const { fetch, calls } = answering(200, result([finding]))

    await validate('<Invoice/>', { fetch, language: 'en' })

    assert.equal(new Headers(calls[0].init.headers).get('Accept-Language'), 'en')
  })

  it('sends no language header when none is configured', async () => {
    const { fetch, calls } = answering(200, result([finding]))

    await new Normapi({ fetch }).validate('<Invoice/>')

    assert.equal(new Headers(calls[0].init.headers).get('Accept-Language'), null)
  })

  it('returns the explanation a finding carries', async () => {
    const { fetch } = answering(200, result([finding]))

    const parsed = await new Normapi({ fetch }).validate('<Invoice/>')

    assert.deepEqual(parsed.findings[0].explanation, explanation)
  })

  it('reads a finding from a deployment without explanations as unexplained', async () => {
    const { explanation: _dropped, ...older } = finding
    const { fetch } = answering(200, result([older]))

    const parsed = await new Normapi({ fetch }).validate('<Invoice/>')

    assert.equal(parsed.findings[0].explanation, null)
  })

  it('refuses an explanation whose link is not an https page', async () => {
    const hostile = { ...finding, explanation: { ...explanation, url: 'javascript:alert(1)' } }
    const { fetch } = answering(200, result([hostile]))

    await assert.rejects(new Normapi({ fetch }).validate('<Invoice/>'), NormapiError)
  })

  it('explains the findings of a refused generation', async () => {
    const { fetch, calls } = answering(422, {
      type: 'https://normapi.de/problems/invoice-not-permitted',
      title: 'Invoice not permitted by the rule set',
      status: 422,
      detail: 'The data describes an invoice the rule set does not permit.',
      rulesetVersion: 'v2026-08-31',
      findings: [finding],
    })

    const error = await new Normapi({ fetch, language: 'de' })
      .generateInvoice({})
      .catch((thrown) => thrown)

    assert.ok(error instanceof InvoiceNotPermittedError)
    assert.equal(error.findings[0].explanation.fix, explanation.fix)
    assert.equal(new Headers(calls[0].init.headers).get('Accept-Language'), 'de')
  })
})
