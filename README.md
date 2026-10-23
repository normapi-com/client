# @normapi/client

Validate, generate and read German e-invoices — **XRechnung** (UBL and CII)
and **ZUGFeRD / Factur-X** hybrid PDFs — against the official KoSIT rule set,
without running a Java toolchain yourself.

This is the client for [NormAPI](https://normapi.de). The service embeds the
official validator and the current XRechnung rule set; this package is a thin,
zero-dependency wrapper around one HTTP call.

```bash
npm install @normapi/client
```

## Validate an invoice

```ts
import { validate } from '@normapi/client'
import { readFile } from 'node:fs/promises'

const result = await validate(await readFile('invoice.xml'), {
  documentName: 'invoice.xml',
  language: 'de', // explanations in German; English when omitted
})

if (result.acceptable) {
  console.log(`valid — checked as ${result.scenario}, rules ${result.rulesetVersion}`)
} else {
  for (const finding of result.findings) {
    console.log(`${finding.severity} ${finding.code}: ${finding.text}`)
    if (finding.explanation !== null) {
      console.log(`  fix: ${finding.explanation.fix}`)
    }
  }
}
```

ZUGFeRD / Factur-X PDFs work the same way — pass the PDF bytes. The service
detects the content, extracts the embedded invoice XML, and validates that:

```ts
const result = await validate(await readFile('rechnung.pdf'))
```

## Generate an invoice

Send invoice data, get back a validated XRechnung 3.0.2 (UBL). The server
computes every total in decimal arithmetic, and **no invoice leaves
unvalidated**: a resolved promise carries XML the official rule set accepted.

```ts
import { generateInvoice, InvoiceNotPermittedError } from '@normapi/client'
import { writeFile } from 'node:fs/promises'

try {
  const { xml, rulesetVersion, scenario } = await generateInvoice({
    invoiceNumber: 'RE-2026-0815',
    issueDate: '2026-08-13',
    dueDate: '2026-09-12',
    currency: 'EUR',
    buyerReference: '04011000-12345-03',
    seller: {
      name: 'Muster Software GmbH',
      vatId: 'DE123456789',
      address: { street: 'Beispielstraße 12', city: 'Berlin', postcode: '10115', country: 'DE' },
      contact: { name: 'Maria Muster', phone: '+49 30 1234567', email: 'maria@muster-software.de' },
    },
    buyer: {
      name: 'Beispiel Handel AG',
      address: { city: 'Hamburg', postcode: '20095', country: 'DE' },
    },
    payment: { meansCode: '58', iban: 'DE02120300000000202051' },
    lines: [
      { name: 'Softwarelizenz', quantity: 3, unit: 'C62', unitPrice: '199.00', vatCategory: 'S', vatRate: 19 },
    ],
  }, { apiKey: process.env.NORMAPI_API_KEY })
  await writeFile('rechnung.xml', xml)
  console.log(`generated — ${scenario}, rules ${rulesetVersion}`)
} catch (error) {
  if (error instanceof InvoiceNotPermittedError) {
    // the data describes an invoice German rules do not permit —
    // each finding names the violated rule (BR-DE-16, …)
    for (const f of error.findings) console.error(`${f.code}: ${f.text}`)
  } else {
    throw error
  }
}
```

Money fields accept strings (`"199.00"`) as well as numbers — strings never
touch a float on their way to the server's BigDecimal.

Prefer CII syntax? `generateInvoice(data, { syntax: 'cii' })`.

### Invoices to businesses: `profile: 'en16931'`

The default is XRechnung, which public-sector buyers require, and which adds
three things to the European norm: a buyer reference (the Leitweg-ID,
BR-DE-15), a seller contact (BR-DE-2) and an electronic address on both sides.
Between businesses § 14 UStG accepts the norm alone. Pass the profile and
leave those out:

```ts
await generateInvoice(
  {
    invoiceNumber: 'SM-2026-047',
    issueDate: '2026-10-20',
    dueDate: '2026-11-03',
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
    lines: [
      { name: 'Logo-Entwicklung', quantity: 1, unit: 'C62', unitPrice: '1200.00', vatCategory: 'S', vatRate: 19 },
    ],
  },
  { profile: 'en16931', apiKey: process.env.NORMAPI_API_KEY },
)
```

The document is then checked against EN 16931 itself (scenario
`EN16931 (UBL Invoice)`), and a ZUGFeRD PDF carries the profile EN 16931.

### Attachments: a timesheet inside the invoice

Supporting documents (BG-24) travel inside the e-invoice as base64, or as a
link. PDF, PNG, JPEG, CSV, XLSX and ODS are permitted, up to 20 files and
3 MB together:

```ts
import { readFile } from 'node:fs/promises'

const timesheet = await readFile('stundennachweis-2026-09.pdf')

await generateInvoice({
  ...invoiceData,
  attachments: [
    {
      id: 'SN-2026-09',
      description: 'Stundennachweis September 2026',
      filename: 'stundennachweis-2026-09.pdf',
      mimeCode: 'application/pdf',
      content: timesheet.toString('base64'),
    },
    { id: 'Leistungsbeschreibung', url: 'https://www.example.com/leistungsbeschreibung.pdf' },
  ],
})
```

A type the rules do not permit, or a filename used twice, is an
`InvoiceNotPermittedError` naming BR-CL-24 or BR-DE-22. In a ZUGFeRD PDF the
files sit in the embedded XML, and the invoice page lists them.

## Generate a ZUGFeRD hybrid PDF

The complete hybrid: a human-readable A4 invoice page as PDF/A-3 with the
validated CII invoice embedded — ready to email to any recipient, with or
without e-invoicing software.

```ts
import { generateInvoicePdf } from '@normapi/client'
import { writeFile } from 'node:fs/promises'

const { pdf, scenario } = await generateInvoicePdf(invoiceData, {
  apiKey: process.env.NORMAPI_API_KEY,
})
await writeFile('rechnung.pdf', pdf)
```

The embedded invoice is an XRechnung; `{ profile: 'en16931' }` makes the PDF a
ZUGFeRD EN 16931 hybrid for a business recipient.

## Read an incoming invoice

`parse` turns a received e-invoice into data — XRechnung or any EN 16931
invoice as UBL or CII, or a ZUGFeRD / Factur-X PDF, whose embedded XML is what
gets read. Free and never counted, like validation; no key needed.

```ts
import { parse } from '@normapi/client'
import { readFile } from 'node:fs/promises'

const { invoice, stated, notMapped } = await parse(await readFile('eingang.pdf'))

console.log(invoice.invoiceNumber, invoice.seller?.name, invoice.payment?.iban)
for (const [index, line] of invoice.lines.entries()) {
  console.log(line.name, line.quantity, line.unit, stated.lines[index]?.netAmount)
}
console.log(`due: ${stated.amountDue} ${invoice.currency}`)
```

- `invoice` has the shape `generateInvoice` takes, so a document can be read,
  changed and generated again — `generateInvoice(invoice, { profile })` with
  the `profile` the result names. Every field is present, `null` where the
  document has no value.
- `stated` holds what generation computes and the invoice shape therefore
  leaves out — the totals, the VAT breakdown, each line's net — as exact
  decimal strings, never a float: `"336.9"` stays `"336.9"`.
- `notMapped` lists every value of the document the result does not carry,
  each path with a count: an item classification, a payee, a date that is no
  date. Empty for an invoice NormAPI generated; nothing is dropped without a
  trace.
- `{ validate: true }` adds the KoSIT verdict as `validation`, exactly what
  `validate` returns. Without it no rules run, and `validation` is `null`.

A document with gaps is read as far as it goes. Only one that is no invoice at
all throws: a `NormapiError` with status 422 and a `detail` that says why —
not well-formed XML, a DOCTYPE, a root that is no invoice, a PDF without one.

## Invoicing for your own customers

Software that generates invoices for its own customers — accounting, a shop
system, a portal — names the customer each call is for. It stays one account
with one allowance; NormAPI counts each customer on its own, and you can hold
any customer to a monthly ceiling.

```ts
import { Normapi, CustomerQuotaExceededError } from '@normapi/client'

// One client per customer, or `{ customer }` on a single call (null for none).
const client = new Normapi({ apiKey: process.env.NORMAPI_KEY, customer: 'tenant-42' })

try {
  const { xml, customerQuota } = await client.generateInvoice(invoice)
  // customerQuota: { used, limit } when tenant-42 has a ceiling, else null
} catch (error) {
  if (error instanceof CustomerQuotaExceededError) {
    // tenant-42 generated its error.limit invoices this month; the others carry on
  }
}

await client.setCustomerAllowance('tenant-42', 500) // at most 500 invoices a month
await client.clearCustomerAllowance('tenant-42')

// The month, to bill each customer on what it generated:
for await (const row of client.customers({ month: '2026-10' })) {
  console.log(row.customer, row.generated, row.refused, row.monthlyInvoices)
}
```

- The reference is `X-Normapi-Customer`: 1–64 letters, digits and `. _ : -`,
  starting with a letter or digit, case-sensitive. Send your internal id,
  never a name or an email address — it is stored in the usage counters and
  the request log.
- It is sent with `validate`, `parse`, `generateInvoice` and
  `generateInvoicePdf`, and counts only on calls with a key.
- `CustomerQuotaExceededError` is a 429 but not a `RateLimitError`: its
  `retryAfterSeconds` runs to the start of the next month (`resetsAt`).
- `listCustomers({ month, limit, cursor })` reads one page; `customers()`
  walks them all; `getCustomer(ref)` reads one. These need a key that belongs
  to an account. A key bound to one customer in the account area counts for
  that customer without the header, sees only that customer, and cannot change
  a ceiling.

## Reading the result

- **`acceptable` is the verdict.** Base accept/reject decisions on this flag
  and nothing else.
- `schematronValid` is *not* a verdict: the German rule set emits
  informational advisories on perfectly valid invoices, and any advisory sets
  it false while `acceptable` stays true.
- `businessRulesEvaluated: false` means a schema failure stopped the pipeline
  early — an empty findings list then means "not checked", never "nothing
  wrong".
- `scenario` names the rules that judged the document: an XRechnung invoice
  gets the German CIUS (`EN16931 XRechnung (UBL Invoice)`), a plain EN 16931
  profile — typical for B2B ZUGFeRD — gets the European core rules
  (`EN16931 (CII)`). `scenario: null` means no rule scenario matched the
  declared profile: nothing was checked, and `acceptable: false` is a refusal
  to judge, not a judgement.
- Every result records `rulesetVersion`, so a verdict can always be traced to
  the rules in force when it was made.
- A generated invoice's `ignoredFields` lists what the data carried that no
  part of an invoice knows — `lines[0].articleNumber` sent for
  `sellerItemId` — and so went into no document. Empty when every field was
  used.
- `text` is the rule set's own wording. `explanation` says the same in plain
  language — `meaning`, `cause`, `fix`, and a `url` to where the rule is
  explained on normapi.de — in German or English (`language: 'de' | 'en'`,
  English by default). Every business rule is explained; `explanation` is
  `null` only on schema findings.

### What a finding's code means

Every finding carries a rule code — `BR-DE-15`, `BR-CO-16`,
`PEPPOL-EN16931-R010` — and the `text` beside it is the rule as the norm words
it, which states the requirement and not why your document broke it.

[**normapi-com/xrechnung-rules-explained**](https://github.com/normapi-com/xrechnung-rules-explained)
is an open reference for those codes: 132 rules in German and English, each
with the mapping habit that actually causes it and a wrong/right XML fragment.
Data under CC BY 4.0, so you can ship it inside your own error messages.

It also documents things the rule list does not — four rules that compile to
`true()` and can never fire, and the pairs of codes that are one check under
two names, so a single missing field reports twice.

### Explain a code you already have

A code from a log, or from another validator's report, gets the same
explanation a finding carries:

```ts
import { explainRule } from '@normapi/client'

const rule = await explainRule('br-de-15', { language: 'de' })
// { code: 'BR-DE-15', language: 'de', explanation: { meaning, cause, fix, url } }
```

Case does not matter; the result spells the code as the rule set does. It
resolves to `null` for a code no rule has — schema findings (`cvc-*`) carry no
explanation.

## Errors

An **invalid invoice is not an error** — it is a successful validation with
`acceptable: false`. Errors are thrown only when the request itself could not
be processed:

```ts
import {
  validate,
  CustomerQuotaExceededError,
  RateLimitError,
  ValidatorBusyError,
  NormapiError,
} from '@normapi/client'

try {
  await validate(xml)
} catch (error) {
  if (error instanceof CustomerQuotaExceededError) {
    // generation only: this customer reached its monthly ceiling — raise it, or wait for the month
  } else if (error instanceof RateLimitError) {
    // over the per-client budget — wait error.retryAfterSeconds, then retry
  } else if (error instanceof ValidatorBusyError) {
    // every validation slot busy — retry after error.retryAfterSeconds
  } else if (error instanceof NormapiError) {
    // 400 empty body, 413 too large, 415 not XML/PDF, 422 unreadable PDF …
    console.error(error.status, error.detail)
  } else {
    throw error // network failure, abort, …
  }
}
```

## Your own deployment

```ts
import { Normapi } from '@normapi/client'

const client = new Normapi({ baseUrl: 'https://api.example.com' })
const result = await client.validate(xml)
```

## Requirements

Node 18+, or any runtime with global `fetch` (browsers, Deno, Bun). No
runtime dependencies.

## Fair use

The public endpoint is rate-limited per client (HTTP 429 with `Retry-After`)
and answers 503 when all validation slots are busy. Both are momentary —
back off and retry. Uploaded invoices are validated in memory and discarded;
see the [privacy policy](https://normapi.de/datenschutz).

## Getting an API key

Validation works without one, under anonymous rate limits — the examples above
need no account. Generating invoices does: create a free account at
[normapi.de](https://normapi.de/en/account) (25 generated invoices a month,
no card), make a key, and pass it as `apiKey`.

## Issues and questions

Bugs and questions belong in
[GitHub issues](https://github.com/normapi-com/client/issues) — that way the answer
helps whoever hits it next. Anything about your account or invoice data instead
goes to kontakt@normapi.de.

## License

MIT — see [LICENSE](./LICENSE).
