/**
 * Client for the NormAPI service — https://normapi.de: validate, generate and
 * read German e-invoices.
 *
 * Zero dependencies. Uses the global fetch, so it runs unchanged in Node 18+,
 * browsers, Deno, and Bun. The response is verified at runtime before it is
 * returned as typed data: this library never asserts a network payload into a
 * type it has not checked.
 */

/** One finding from the rule set — a violation, warning, or notice. */
export interface Finding {
  /** Rule identifier, e.g. `BR-CO-16`, or a `cvc-*` XML schema constraint. */
  readonly code: string
  readonly severity: 'ERROR' | 'WARNING' | 'INFORMATION'
  /** The rule set's own explanation text (German for BR-DE rules). */
  readonly text: string
  readonly origin: 'SCHEMA' | 'SCHEMATRON'
  /** XPath of the offending node; null for schema findings. */
  readonly location: string | null
  /** Line in the document; null for Schematron findings. */
  readonly line: number | null
  /** Column in the document; null for Schematron findings. */
  readonly column: number | null
  /** The assertion that failed; null for schema findings. */
  readonly test: string | null
  /**
   * The rule in plain language, in the language the client asked for (see
   * {@link ClientOptions.language}). Every business rule is explained; null
   * means a schema finding, or a deployment from before explanations existed.
   */
  readonly explanation: Explanation | null
}

/** What a rule requires, why it typically fires, and how to fix it. */
export interface Explanation {
  /** What the rule actually requires, in ordinary language. */
  readonly meaning: string
  /** Why an invoice typically trips it. */
  readonly cause: string
  /** What to change to make it pass. */
  readonly fix: string
  /** The page with the full explanation and an XML example. */
  readonly url: string
}

export interface ValidationResult {
  /** The verdict — the one flag to base an accept/reject decision on. */
  readonly acceptable: boolean
  readonly wellFormed: boolean
  readonly schemaValid: boolean
  /**
   * Whether the business rules produced no findings at all. Not a verdict:
   * informational advisories set this false on perfectly valid invoices.
   */
  readonly schematronValid: boolean
  /**
   * False when a schema failure stopped the run early — an empty findings
   * list then means "not checked", never "nothing wrong".
   */
  readonly businessRulesEvaluated: boolean
  /** The rule set release that produced this verdict, e.g. `v2026-01-31`. */
  readonly rulesetVersion: string
  /**
   * Which rule scenario judged the document — e.g. `EN16931 XRechnung (UBL
   * Invoice)` or `EN16931 (CII)`. Null when no scenario matched, in which
   * case nothing was checked and `acceptable: false` is a refusal to judge.
   */
  readonly scenario: string | null
  readonly findings: readonly Finding[]
}

/** The service rejected or could not process the request (4xx/5xx). */
export class NormapiError extends Error {
  readonly status: number
  /** RFC 9457 problem detail from the response body, when one was sent. */
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message)
    this.name = 'NormapiError'
    this.status = status
    this.detail = detail
  }
}

/** 429 — this client is over its request budget. Wait and retry. */
export class RateLimitError extends NormapiError {
  /** Seconds to wait before retrying, from the Retry-After header. */
  readonly retryAfterSeconds: number

  constructor(detail: string, retryAfterSeconds: number) {
    super('rate limit exceeded', 429, detail)
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * 429 from generation — the customer named in X-Normapi-Customer reached the
 * monthly ceiling the account set for it. Not a rate limit, and deliberately
 * not a {@link RateLimitError}: waiting {@link retryAfterSeconds} means waiting
 * until the month turns. The account's other customers, and validation, carry
 * on; raise the ceiling with {@link Normapi.setCustomerAllowance} to go on now.
 */
export class CustomerQuotaExceededError extends NormapiError {
  readonly customer: string
  /** Invoices the customer generated this month. */
  readonly used: number
  /** The ceiling. */
  readonly limit: number
  /** When the next month starts, from the problem's `resetsAt`; null if it was absent. */
  readonly resetsAt: Date | null
  readonly retryAfterSeconds: number

  constructor(
    detail: string,
    customer: string,
    used: number,
    limit: number,
    resetsAt: Date | null,
    retryAfterSeconds: number,
  ) {
    super('customer ceiling reached', 429, detail)
    this.name = 'CustomerQuotaExceededError'
    this.customer = customer
    this.used = used
    this.limit = limit
    this.resetsAt = resetsAt
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 503 — every validation slot is busy. Retrying shortly is the fix. */
export class ValidatorBusyError extends NormapiError {
  readonly retryAfterSeconds: number

  constructor(detail: string, retryAfterSeconds: number) {
    super('validator at capacity', 503, detail)
    this.name = 'ValidatorBusyError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * 422 from generation — the data describes an invoice the official rule set
 * does not permit. Not a bug and not a malformed request: each finding names
 * the violated rule (e.g. BR-DE-16), exactly as the validation endpoint
 * would report it.
 */
export class InvoiceNotPermittedError extends NormapiError {
  readonly findings: readonly Finding[]
  readonly rulesetVersion: string

  constructor(detail: string, findings: readonly Finding[], rulesetVersion: string) {
    super('invoice not permitted by the rule set', 422, detail)
    this.name = 'InvoiceNotPermittedError'
    this.findings = findings
    this.rulesetVersion = rulesetVersion
  }
}

export interface ValidateOptions {
  /** Filename echoed into the report; never interpreted. */
  readonly documentName?: string
  /**
   * The customer this call is for, overriding the client's `customer`; null
   * sends none. See {@link ClientOptions.customer}.
   */
  readonly customer?: string | null
  readonly signal?: AbortSignal
}

export interface ExplainRuleOptions {
  readonly signal?: AbortSignal
}

/** One rule, explained — what {@link Normapi.explainRule} resolves to. */
export interface RuleInfo {
  /** The code as the rule set spells it, e.g. `BR-DE-23-a`. */
  readonly code: string
  /** The language the explanation is written in. */
  readonly language: 'de' | 'en'
  readonly explanation: Explanation
}

/**
 * The rules a generated invoice follows. `xrechnung` (the server's default) is
 * the German CIUS public-sector buyers require: it adds a buyer reference
 * (BR-DE-15), a seller contact (BR-DE-2) and both electronic addresses to
 * EN 16931. `en16931` is the norm alone, which § 14 UStG accepts between
 * businesses; in a ZUGFeRD PDF it is the profile EN 16931.
 */
export type Profile = 'xrechnung' | 'en16931'

export interface GenerateOptions {
  /** Output syntax: UBL (default) or UN/CEFACT CII. */
  readonly syntax?: 'ubl' | 'cii'
  /** XRechnung when absent. */
  readonly profile?: Profile
  /**
   * The customer this call is for, overriding the client's `customer`; null
   * sends none. See {@link ClientOptions.customer}.
   */
  readonly customer?: string | null
  readonly signal?: AbortSignal
}

/**
 * The invoice to generate — the JSON body of {@code POST /v1/invoices}.
 *
 * Send lines; every total is computed server-side in decimal arithmetic. Money
 * fields accept strings as well as numbers: {@code "19.90"} survives JSON
 * without ever touching a float, which is the safest way to carry an amount.
 *
 * Structural minimums are typed here; whether a *combination* is permitted is
 * the rule set's verdict — violations surface as {@link InvoiceNotPermittedError}
 * naming the exact rule, not as client-side guesses.
 */
export interface InvoiceInput {
  /** BT-1. */
  readonly invoiceNumber: string
  /** BT-2, as YYYY-MM-DD. */
  readonly issueDate: string
  /**
   * BT-3, UNTDID 1001; "380" when absent. "381" credit note, "384" corrected
   * invoice, "326" partial, "389" self-billed, "875"–"877" construction.
   */
  readonly typeCode?: string
  /** BG-3, the invoices this one corrects, credits or settles. CII carries one. */
  readonly precedingInvoices?: readonly PrecedingInvoiceInput[]
  /** BT-9. Payable invoices need this or paymentTerms (BR-CO-25). */
  readonly dueDate?: string
  /** BT-72. Omitting it and invoicePeriod draws an advisory from the rule set. */
  readonly deliveryDate?: string
  /** BG-13: where the supply went. Category K needs its country (BR-IC-12). */
  readonly deliverTo?: DeliverToInput
  /** BG-14, the period a monthly or yearly invoice covers. */
  readonly invoicePeriod?: PeriodInput
  /** BT-5, ISO 4217 — e.g. "EUR". */
  readonly currency: string
  /**
   * BT-10 — the Leitweg-ID for public-sector buyers, else the buyer's own
   * reference. Mandatory in XRechnung (BR-DE-15), optional in EN 16931.
   */
  readonly buyerReference?: string
  /** BT-13, the buyer's purchase order number. */
  readonly orderReference?: string
  /** BT-12. */
  readonly contractReference?: string
  /** BT-11. */
  readonly projectReference?: string
  /** BT-16, the delivery note (Lieferschein). */
  readonly despatchAdviceReference?: string
  /** BG-24, supporting documents: at most 20, their files 3 MB together. */
  readonly attachments?: readonly AttachmentInput[]
  /** BT-22. */
  readonly note?: string
  readonly seller: PartyInput
  readonly buyer: PartyInput
  readonly payment: PaymentInput
  /** BT-20. */
  readonly paymentTerms?: string
  /** BG-20, allowances on the whole document. */
  readonly allowances?: readonly AllowanceChargeInput[]
  /** BG-21, charges on the whole document — freight, packaging. */
  readonly charges?: readonly AllowanceChargeInput[]
  /** BT-113, already paid; the amount due is the total less this. */
  readonly prepaidAmount?: number | string
  readonly lines: readonly LineInput[]
}

export interface PrecedingInvoiceInput {
  /** BT-25. */
  readonly number: string
  /** BT-26, as YYYY-MM-DD. */
  readonly issueDate?: string
}

/** Either end may stand alone (BR-CO-19, BR-CO-20). */
export interface PeriodInput {
  /** BT-73 / BT-134, as YYYY-MM-DD. */
  readonly startDate?: string
  /** BT-74 / BT-135, as YYYY-MM-DD. */
  readonly endDate?: string
}

export interface DeliverToInput {
  /** BT-70, who received the goods. */
  readonly name?: string
  /** BT-71, e.g. a GLN. */
  readonly locationId?: string
  /** BT-71-1, ISO 6523 ICD: "0088" for a GLN. */
  readonly locationIdScheme?: string
  /** BG-15. */
  readonly address?: AddressInput
}

/**
 * BG-24, one supporting document: a file inside the invoice (content with
 * filename and mimeCode), a link (url), or a reference alone. BR-CL-24
 * permits PDF, PNG, JPEG, CSV, XLSX and ODS; BR-DE-22 one use of a filename.
 */
export interface AttachmentInput {
  /** BT-122; the filename when absent (BR-52). */
  readonly id?: string
  /** BT-123. */
  readonly description?: string
  /** BT-125-2. */
  readonly filename?: string
  /** BT-125-1, e.g. "application/pdf". */
  readonly mimeCode?: string
  /** BT-125, the file as base64 — of the type mimeCode names. */
  readonly content?: string
  /** BT-124, an http(s) address the buyer can fetch the document from. */
  readonly url?: string
}

/** BG-20 / BG-21. Give amount or percent, exactly one; reason or reasonCode. */
export interface AllowanceChargeInput extends LineAllowanceChargeInput {
  /** BT-95 / BT-102, UNTDID 5305. */
  readonly vatCategory: 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M'
  /** BT-96 / BT-103, percent. */
  readonly vatRate?: number | string
  /** BT-120, as on a line. */
  readonly vatExemptionReason?: string
}

/** BG-27 / BG-28: changes the line net, in the line's VAT category. */
export interface LineAllowanceChargeInput {
  readonly amount?: number | string
  readonly percent?: number | string
  /** What the percentage is taken of; only with percent (PEPPOL-EN16931-R042). */
  readonly baseAmount?: number | string
  readonly reason?: string
  /** UNTDID 5189 for an allowance (95 discount), UNTDID 7161 for a charge (FC freight). */
  readonly reasonCode?: string
}

export interface PartyInput {
  /** BT-27 / BT-44 — the legal name. */
  readonly name: string
  /**
   * BT-29 / BT-46. Sellers without a VAT id need this for BR-CO-26 — the tax
   * number alone satisfies only BR-DE-16; repeating it here is fine.
   */
  readonly identifier?: string
  /** BT-31 / BT-48, e.g. "DE123456789". */
  readonly vatId?: string
  /** BT-32 — the German Steuernummer. */
  readonly taxNumber?: string
  /** BT-34 / BT-49, usually an email address. XRechnung requires both sides'. */
  readonly electronicAddress?: string
  /** EAS code for the electronic address; defaults to "EM" (email). */
  readonly electronicAddressScheme?: string
  readonly address: AddressInput
  /** BG-6 — XRechnung requires it on the seller, all three parts (BR-DE-2 through 7). */
  readonly contact?: ContactInput
  /** BT-28 / BT-45, the name traded under beside the legal one. */
  readonly tradingName?: string
  /** BT-30 / BT-47, the register entry — "HRB 123456" for a GmbH. */
  readonly registrationId?: string
  /** BT-30-1 / BT-47-1, ISO 6523 ICD: none for German registers, "0002" for a SIREN. */
  readonly registrationIdScheme?: string
  /**
   * BT-33, seller only: seat, register court and managing directors, as
   * § 35a GmbHG wants on business letters.
   */
  readonly legalInformation?: string
}

export interface AddressInput {
  readonly street?: string
  readonly city: string
  readonly postcode: string
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  readonly country: string
}

export interface ContactInput {
  /** BT-41. */
  readonly name?: string
  /** BT-42. */
  readonly phone?: string
  /** BT-43. */
  readonly email?: string
}

export interface PaymentInput {
  /**
   * BT-81, UNTDID 4461 — "58" SEPA credit transfer, "30" credit transfer,
   * "59" SEPA direct debit, "48"/"54"/"55" card, "10" cash.
   */
  readonly meansCode: string
  /** BT-82, the means in words. */
  readonly meansText?: string
  /** BT-84 — required by BR-DE-23-a for transfer codes. */
  readonly iban?: string
  /** BT-85, the payee account holder. */
  readonly accountName?: string
  /** BT-86. */
  readonly bic?: string
  /** BT-83 — remittance information. */
  readonly reference?: string
  /** BG-18, with means 48, 54 or 55. */
  readonly card?: CardInput
  /** BG-19, with means 59; leave out the payee IBAN (BR-DE-25-b). */
  readonly directDebit?: DirectDebitInput
}

export interface CardInput {
  /** BT-87: at most the first 6 and last 4 digits, without mask characters. */
  readonly number: string
  /** BT-88. */
  readonly holder?: string
  /** VISA, MasterCard …; UBL writes NA when absent. */
  readonly network?: string
}

export interface DirectDebitInput {
  /** BT-89. */
  readonly mandateReference?: string
  /** BT-90, the SEPA creditor identifier. */
  readonly creditorId?: string
  /** BT-91, the buyer IBAN debited. */
  readonly debitedAccount?: string
}

export interface LineInput {
  /** BT-126; assigned 1..n when absent. */
  readonly id?: string
  /** BT-153. */
  readonly name: string
  /** BT-154. */
  readonly description?: string
  /** BT-129, up to six decimals. */
  readonly quantity: number | string
  /** BT-130, UN/ECE Rec 20 — "C62" piece, "HUR" hour … */
  readonly unit: string
  /** BT-146, net, up to four decimals — per `baseQuantity` units when one is given. */
  readonly unitPrice: number | string
  /** BT-151, UNTDID 5305. */
  readonly vatCategory: 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M'
  /** BT-152, percent — required for category S. */
  readonly vatRate?: number | string
  /** BT-120 — demanded by the rule set for the exempt-family categories. */
  readonly vatExemptionReason?: string
  /** BG-27. */
  readonly allowances?: readonly LineAllowanceChargeInput[]
  /** BG-28. */
  readonly charges?: readonly LineAllowanceChargeInput[]
  /** BG-26, the period this line covers. */
  readonly period?: PeriodInput
  /** BT-132, the line of the buyer's purchase order this one bills. */
  readonly orderLineReference?: string
  /** BT-127, free text on this line. */
  readonly note?: string
  /** BT-155, the seller's article number. */
  readonly sellerItemId?: string
  /** BT-156, the buyer's own number for the article. */
  readonly buyerItemId?: string
  /** BT-157, e.g. the GTIN (EAN) on the packaging. */
  readonly standardItemId?: string
  /** BT-157-1, the ISO 6523 ICD of `standardItemId`; "0160" (GTIN) when absent. */
  readonly standardItemIdScheme?: string
  /** BT-148, the price before the discount, at least `unitPrice`; BT-147 is the difference. */
  readonly listPrice?: number | string
  /** BT-149, how many units `unitPrice` and `listPrice` are for — 100 for a price per hundred. */
  readonly baseQuantity?: number | string
}

/** What generation returns: the document, plus the provenance headers. */
export interface GeneratedInvoice {
  /** The XML document, exactly as the API returned it. */
  readonly xml: string
  /** The rule set that validated the document before it left, e.g. "v2026-01-31". */
  readonly rulesetVersion: string | null
  /** The scenario the document passed, e.g. "EN16931 XRechnung (UBL Invoice)". */
  readonly scenario: string | null
  /**
   * Fields of the invoice data that no part of an invoice knows, so they are in no
   * document — "lines[0].articleNumber". Empty when every field was used.
   */
  readonly ignoredFields: readonly string[]
  /** The customer the invoice was counted for, as the service sent it back; null without one. */
  readonly customer: string | null
  /** For a customer with a monthly ceiling: its invoices this month before this one, and the ceiling. */
  readonly customerQuota: CustomerQuota | null
}

/** A customer's ceiling as a generation reports it. */
export interface CustomerQuota {
  readonly used: number
  readonly limit: number
}

export interface GeneratePdfOptions {
  /** XRechnung when absent; `en16931` makes it a ZUGFeRD EN 16931 hybrid. */
  readonly profile?: Profile
  /**
   * The customer this call is for, overriding the client's `customer`; null
   * sends none. See {@link ClientOptions.customer}.
   */
  readonly customer?: string | null
  readonly signal?: AbortSignal
}

/** A ZUGFeRD hybrid: the readable PDF with the validated invoice embedded. */
export interface GeneratedInvoicePdf {
  /** PDF/A-3 bytes — write them to a file and the invoice is ready to send. */
  readonly pdf: Uint8Array
  readonly rulesetVersion: string | null
  /** The rules the embedded invoice passed, e.g. "EN16931 XRechnung (CII)". */
  readonly scenario: string | null
  /** As for {@link GeneratedInvoice}: the fields no document took up. */
  readonly ignoredFields: readonly string[]
  readonly customer: string | null
  readonly customerQuota: CustomerQuota | null
}

/** A customer's numbers for a month — generated is what to bill it on. */
export interface CustomerCounts {
  /** Invoices generated (2xx). */
  readonly generated: number
  /** Generations refused with a 4xx: the data, a limit or the ceiling. */
  readonly refused: number
  /** Calls per endpoint, every status: `generate`, `validate`, and any other. */
  readonly calls: Readonly<Record<string, number>>
}

export interface CustomerMonth extends CustomerCounts {
  readonly customer: string
  /** The ceiling in force now, or null without one. */
  readonly monthlyInvoices: number | null
}

/** One page of {@link Normapi.listCustomers}. */
export interface CustomerPage {
  /** `YYYY-MM`. */
  readonly month: string
  /** Most invoices generated first. */
  readonly customers: readonly CustomerMonth[]
  /** The calls that named no customer; null for a key bound to a customer. */
  readonly withoutCustomer: CustomerCounts | null
  /** Pass as `cursor` for the next page; null on the last. */
  readonly nextCursor: string | null
}

export interface CustomerAllowance {
  readonly customer: string
  readonly monthlyInvoices: number
}

export interface ListCustomersOptions {
  /** The calendar month, `YYYY-MM`; the current one when absent. */
  readonly month?: string
  /** Customers per page, 1–1000; the service's default is 100. */
  readonly limit?: number
  /** The previous page's `nextCursor`. */
  readonly cursor?: string
  readonly signal?: AbortSignal
}

export interface GetCustomerOptions {
  /** The calendar month, `YYYY-MM`; the current one when absent. */
  readonly month?: string
  readonly signal?: AbortSignal
}

export interface CustomerAllowanceOptions {
  readonly signal?: AbortSignal
}

export interface ParseOptions {
  /**
   * Also run the KoSIT validation and return its verdict as `validation` —
   * exactly what {@link Normapi.validate} would return. Off by default: reading
   * an invoice does not need the rule set, and is much faster without it.
   */
  readonly validate?: boolean
  /**
   * The customer this call is for, overriding the client's `customer`; null
   * sends none. See {@link ClientOptions.customer}.
   */
  readonly customer?: string | null
  readonly signal?: AbortSignal
}

/**
 * An incoming invoice, read — what {@link Normapi.parse} resolves to.
 *
 * `invoice` is in the shape {@link Normapi.generateInvoice} takes, so a document
 * can be read, changed and generated again. The amounts generation computes are
 * not part of that shape; `stated` has them as the document states them.
 * `notMapped` lists every value of the document that this result does not
 * carry: nothing is lost without a trace.
 */
export interface ParseResult {
  readonly syntax: 'ubl' | 'cii'
  /** UBL says so by its root element; in CII the type code (BT-3) decides. */
  readonly documentKind: 'invoice' | 'creditNote'
  readonly source: ParseSource
  /** BT-24, the rules the document declares. */
  readonly specificationId: string | null
  /** BT-23. */
  readonly businessProcess: string | null
  /**
   * The {@link Profile} that declares exactly this BT-24 — what to pass to
   * generate the invoice again under the same rules. Null for any other
   * declaration: XRechnung 2.x, a ZUGFeRD BASIC or EXTENDED profile …
   */
  readonly profile: Profile | null
  readonly invoice: ParsedInvoiceData
  readonly stated: StatedAmounts
  readonly notMapped: readonly NotMappedValue[]
  /** With {@link ParseOptions.validate}, the verdict; otherwise null. */
  readonly validation: ValidationResult | null
}

export interface ParseSource {
  readonly kind: 'xml' | 'pdf'
  /** For a PDF, the embedded file the invoice was read from, e.g. "factur-x.xml". */
  readonly attachment: string | null
}

/**
 * A value of the document that the result does not carry: one the invoice
 * shape has no place for (an item classification, the payee), one that cannot
 * be read as what it should be (a date that is no date), or a repetition of
 * something the shape holds once — the first is read, the rest listed here.
 */
export interface NotMappedValue {
  /** Where, without positions: `/Invoice/cac:InvoiceLine/cac:Item/cac:CommodityClassification/cbc:ItemClassificationCode`. */
  readonly path: string
  /** How often — once per line for a line-level element. */
  readonly count: number
}

/**
 * The amounts the document states that generation computes, exactly as
 * written: `"336.9"` stays `"336.9"`, and none of them passed through a float.
 * Null where the document states none. Whether they add up is the rule set's
 * question — ask with {@link ParseOptions.validate}.
 */
export interface StatedAmounts {
  /** BT-106, the sum of the line nets. */
  readonly lineTotal: string | null
  /** BT-107. */
  readonly allowanceTotal: string | null
  /** BT-108. */
  readonly chargeTotal: string | null
  /** BT-109, the total without VAT. */
  readonly netTotal: string | null
  /** BT-110, in the invoice currency. */
  readonly vatTotal: string | null
  /** BT-6, when VAT is also accounted in another currency. */
  readonly vatAccountingCurrency: string | null
  /** BT-111, the VAT total in that currency. */
  readonly vatTotalInAccountingCurrency: string | null
  /** BT-112, the total with VAT. */
  readonly grossTotal: string | null
  /** BT-113 — also in `invoice.prepaidAmount`. */
  readonly prepaidAmount: string | null
  /** BT-114. */
  readonly roundingAmount: string | null
  /** BT-115. */
  readonly amountDue: string | null
  /** BG-23, one entry per VAT category and rate. */
  readonly vatBreakdown: readonly StatedVatBreakdown[]
  /** One per entry of `invoice.lines`, in the same order. */
  readonly lines: readonly StatedLine[]
  /** One per entry of `invoice.allowances`. */
  readonly allowances: readonly StatedAdjustment[]
  /** One per entry of `invoice.charges`. */
  readonly charges: readonly StatedAdjustment[]
}

export interface StatedVatBreakdown {
  /** BT-118. */
  readonly category: string | null
  /** BT-119. */
  readonly rate: string | null
  /** BT-116. */
  readonly taxableAmount: string | null
  /** BT-117. */
  readonly vatAmount: string | null
  /** BT-120 — also on every line, allowance and charge of the group. */
  readonly exemptionReason: string | null
  /** BT-121, which the invoice shape does not carry. */
  readonly exemptionReasonCode: string | null
}

export interface StatedLine {
  /** BT-131. */
  readonly netAmount: string | null
  /** BT-147 — the invoice shape derives it from listPrice and unitPrice. */
  readonly priceDiscount: string | null
  /** One per entry of the line's allowances. */
  readonly allowances: readonly StatedAdjustment[]
  /** One per entry of the line's charges. */
  readonly charges: readonly StatedAdjustment[]
}

export interface StatedAdjustment {
  /** As stated — where the invoice has a percentage, the amount the document derived from it. */
  readonly amount: string | null
}

/**
 * {@link InvoiceInput} as a document holds it: every field present, null where
 * the document has no value. An incoming invoice can lack what generation
 * requires, so the required fields are nullable here too; send it back as it
 * is and the service names the first gap in a 400. Amounts are JSON numbers;
 * the exact decimals are in {@link StatedAmounts}.
 */
export interface ParsedInvoiceData {
  readonly invoiceNumber: string | null
  readonly issueDate: string | null
  /** "380" when the document states none, as in a request. */
  readonly typeCode: string
  readonly precedingInvoices: readonly ParsedPrecedingInvoice[]
  readonly dueDate: string | null
  readonly deliveryDate: string | null
  readonly deliverTo: ParsedDeliverTo | null
  readonly invoicePeriod: ParsedPeriod | null
  readonly currency: string | null
  readonly buyerReference: string | null
  readonly orderReference: string | null
  readonly contractReference: string | null
  readonly projectReference: string | null
  readonly despatchAdviceReference: string | null
  readonly attachments: readonly ParsedAttachment[]
  readonly note: string | null
  readonly seller: ParsedParty | null
  readonly buyer: ParsedParty | null
  readonly payment: ParsedPayment | null
  readonly paymentTerms: string | null
  readonly allowances: readonly ParsedAllowanceCharge[]
  readonly charges: readonly ParsedAllowanceCharge[]
  readonly prepaidAmount: number | null
  readonly lines: readonly ParsedLine[]
}

export interface ParsedPrecedingInvoice {
  readonly number: string | null
  readonly issueDate: string | null
}

export interface ParsedPeriod {
  readonly startDate: string | null
  readonly endDate: string | null
}

export interface ParsedDeliverTo {
  readonly name: string | null
  readonly locationId: string | null
  readonly locationIdScheme: string | null
  readonly address: ParsedAddress | null
}

export interface ParsedAttachment {
  readonly id: string | null
  readonly description: string | null
  readonly filename: string | null
  readonly mimeCode: string | null
  /** The file as base64. */
  readonly content: string | null
  readonly url: string | null
}

export interface ParsedParty {
  readonly name: string | null
  readonly identifier: string | null
  readonly vatId: string | null
  readonly taxNumber: string | null
  readonly electronicAddress: string | null
  readonly electronicAddressScheme: string | null
  readonly address: ParsedAddress | null
  readonly contact: ParsedContact | null
  readonly tradingName: string | null
  readonly registrationId: string | null
  readonly registrationIdScheme: string | null
  readonly legalInformation: string | null
}

export interface ParsedAddress {
  readonly street: string | null
  readonly city: string | null
  readonly postcode: string | null
  readonly country: string | null
}

export interface ParsedContact {
  readonly name: string | null
  readonly phone: string | null
  readonly email: string | null
}

export interface ParsedPayment {
  readonly meansCode: string | null
  readonly iban: string | null
  readonly reference: string | null
  readonly meansText: string | null
  readonly accountName: string | null
  readonly bic: string | null
  readonly card: ParsedCard | null
  readonly directDebit: ParsedDirectDebit | null
}

export interface ParsedCard {
  readonly number: string | null
  readonly holder: string | null
  /** Null in CII, which has no place for it. */
  readonly network: string | null
}

export interface ParsedDirectDebit {
  readonly mandateReference: string | null
  readonly creditorId: string | null
  readonly debitedAccount: string | null
}

/** With a percentage, `percent` and `baseAmount` are set and `amount` is null. */
export interface ParsedLineAllowanceCharge {
  readonly amount: number | null
  readonly percent: number | null
  readonly baseAmount: number | null
  readonly reason: string | null
  readonly reasonCode: string | null
}

export interface ParsedAllowanceCharge extends ParsedLineAllowanceCharge {
  readonly vatCategory: string | null
  readonly vatRate: number | null
  readonly vatExemptionReason: string | null
}

export interface ParsedLine {
  readonly id: string | null
  readonly name: string | null
  readonly description: string | null
  readonly quantity: number | null
  readonly unit: string | null
  readonly unitPrice: number | null
  readonly vatCategory: string | null
  readonly vatRate: number | null
  readonly vatExemptionReason: string | null
  readonly allowances: readonly ParsedLineAllowanceCharge[]
  readonly charges: readonly ParsedLineAllowanceCharge[]
  readonly period: ParsedPeriod | null
  readonly orderLineReference: string | null
  readonly note: string | null
  readonly sellerItemId: string | null
  readonly buyerItemId: string | null
  readonly standardItemId: string | null
  readonly standardItemIdScheme: string | null
  readonly listPrice: number | null
  readonly baseQuantity: number | null
}

export interface ClientOptions {
  /** Defaults to the public service. Point at your own deployment to override. */
  readonly baseUrl?: string
  /**
   * Your NormAPI key (`nk_live_…`), sent as a Bearer token. Generation needs
   * one; validation and rule lookups work without it under anonymous limits,
   * and with it under your key's.
   */
  readonly apiKey?: string
  /** Custom fetch, e.g. for proxies or instrumentation. Defaults to global fetch. */
  readonly fetch?: typeof fetch
  /**
   * The language of the findings' explanations, sent as Accept-Language.
   * The service answers in English when none is given. The rule set's own
   * `text` is never translated.
   */
  readonly language?: 'de' | 'en'
  /**
   * For software that invoices on behalf of its own customers: your reference
   * for the customer, sent as X-Normapi-Customer with every validation, parse
   * and generation of this client — one client per customer, or set it per
   * call instead. 1–64 letters, digits and `. _ : -`, starting with a letter or
   * digit; your own id, never a name or an email address. The service counts
   * each customer on its own and can hold it to a monthly ceiling; it ignores
   * the header on calls without a key.
   */
  readonly customer?: string
}

const PUBLIC_BASE_URL = 'https://api.normapi.de'

export class Normapi {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly language: 'de' | 'en' | undefined
  private readonly apiKey: string | undefined
  private readonly customer: string | undefined

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PUBLIC_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    this.language = options.language
    this.apiKey = options.apiKey
    this.customer = options.customer
  }

  /**
   * Request headers, with the explanation language and key when configured,
   * and the customer: the call's own, else the client's; null sends none.
   */
  private headers(contentType?: string, customer?: string | null): Record<string, string> {
    const headers: Record<string, string> = {}
    if (contentType !== undefined) {
      headers['Content-Type'] = contentType
    }
    const named = customer === undefined ? this.customer : customer
    if (named !== undefined && named !== null && named !== '') {
      headers['X-Normapi-Customer'] = named
    }
    if (this.language !== undefined) {
      headers['Accept-Language'] = this.language
    }
    if (this.apiKey !== undefined && this.apiKey !== '') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }
    return headers
  }

  /**
   * Explain one rule by its code — the same text a finding carries, for a
   * code you already have: from a log, from another validator's report.
   *
   * The code is matched without regard to case; the result names it as the
   * rule set spells it. Resolves to null when no rule by that code is
   * explained — schema findings (`cvc-*`) never are.
   */
  async explainRule(code: string, options: ExplainRuleOptions = {}): Promise<RuleInfo | null> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/rules/${encodeURIComponent(code.trim())}`,
      { method: 'GET', headers: this.headers(), signal: options.signal ?? null },
    )

    const body: unknown = await response.json().catch(() => null)

    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw errorFor(response, body)
    }

    const info = parseRuleInfo(body)
    if (info === null) {
      throw new NormapiError('unexpected response shape from the rules service', response.status, '')
    }
    return info
  }

  /**
   * Validate one invoice document.
   *
   * Accepts XRechnung XML (UBL or CII) as a string or bytes, or a
   * ZUGFeRD/Factur-X hybrid PDF as bytes — the service detects the kind from
   * the content, never from a declared type.
   *
   * An invalid invoice is a *successful* call: the verdict is in
   * `result.acceptable`. Errors are thrown only when the request itself
   * could not be processed.
   */
  async validate(
    document: string | Uint8Array | ArrayBuffer,
    options: ValidateOptions = {},
  ): Promise<ValidationResult> {
    const headers = this.headers('application/xml', options.customer)
    if (options.documentName !== undefined) {
      headers['X-Document-Name'] = options.documentName
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/validate`, {
      method: 'POST',
      headers,
      body: toBody(document),
      signal: options.signal ?? null,
    })

    const body: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      throw errorFor(response, body)
    }

    const result = parseValidationResult(body)
    if (result === null) {
      throw new NormapiError(
        'unexpected response shape from the validation service',
        response.status,
        '',
      )
    }
    return result
  }

  /**
   * Read an incoming invoice into data: the same documents {@link validate}
   * takes — XRechnung or any EN 16931 invoice as UBL or CII, a ZUGFeRD/Factur-X
   * PDF — detected from the content. Free and never counted, like validation.
   *
   * A document with gaps is read as far as it goes: what it lacks is null, and
   * what cannot be read as its type is null and listed in `notMapped`. Only a
   * document that is no invoice at all throws — a 422 whose `detail` says why
   * (not well-formed, a DOCTYPE, the wrong root element, a PDF without one).
   */
  async parse(
    document: string | Uint8Array | ArrayBuffer,
    options: ParseOptions = {},
  ): Promise<ParseResult> {
    const search = options.validate === true ? '?validate=true' : ''
    const response = await this.fetchImpl(`${this.baseUrl}/v1/parse${search}`, {
      method: 'POST',
      headers: this.headers('application/xml', options.customer),
      body: toBody(document),
      signal: options.signal ?? null,
    })

    const body: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      throw errorFor(response, body)
    }

    const result = parseParseResult(body)
    if (result === null) {
      throw new NormapiError('unexpected response shape from the parse service', response.status, '')
    }
    return result
  }

  /**
   * Generate a validated e-invoice from invoice data: an XRechnung (UBL) unless
   * the options say otherwise.
   *
   * The server computes every total and validates the generated document
   * against the official rule set before responding — a resolved promise
   * carries XML that passed. Data the rules reject throws
   * {@link InvoiceNotPermittedError} with the findings.
   *
   * A {@link ParseResult.invoice} may be sent as it came, changed or not: what
   * generation requires and the document lacked comes back as a 400 that names
   * the field.
   */
  async generateInvoice(
    invoice: InvoiceInput | ParsedInvoiceData,
    options: GenerateOptions = {},
  ): Promise<GeneratedInvoice> {
    const query = new URLSearchParams()
    if (options.syntax !== undefined) query.set('syntax', options.syntax)
    if (options.profile !== undefined) query.set('profile', options.profile)
    const search = query.toString() === '' ? '' : `?${query.toString()}`
    const response = await this.fetchImpl(`${this.baseUrl}/v1/invoices${search}`, {
      method: 'POST',
      headers: this.headers('application/json', options.customer),
      body: JSON.stringify(invoice),
      signal: options.signal ?? null,
    })

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw generationErrorFor(response, body)
    }

    return {
      xml: await response.text(),
      rulesetVersion: response.headers.get('X-Normapi-Ruleset'),
      scenario: response.headers.get('X-Normapi-Scenario'),
      ignoredFields: ignoredFieldsOf(response),
      customer: response.headers.get('X-Normapi-Customer'),
      customerQuota: customerQuotaOf(response),
    }
  }

  /**
   * Generate a complete ZUGFeRD hybrid: a PDF/A-3 with a human-readable invoice page and
   * the validated CII invoice embedded. Same guarantee as {@link generateInvoice} — the
   * embedded document passed the official rule set before the response existed.
   */
  async generateInvoicePdf(
    invoice: InvoiceInput | ParsedInvoiceData,
    options: GeneratePdfOptions = {},
  ): Promise<GeneratedInvoicePdf> {
    const profile = options.profile === undefined ? '' : `&profile=${options.profile}`
    const response = await this.fetchImpl(`${this.baseUrl}/v1/invoices?syntax=zugferd${profile}`, {
      method: 'POST',
      headers: this.headers('application/json', options.customer),
      body: JSON.stringify(invoice),
      signal: options.signal ?? null,
    })

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw generationErrorFor(response, body)
    }

    return {
      pdf: new Uint8Array(await response.arrayBuffer()),
      rulesetVersion: response.headers.get('X-Normapi-Ruleset'),
      scenario: response.headers.get('X-Normapi-Scenario'),
      ignoredFields: ignoredFieldsOf(response),
      customer: response.headers.get('X-Normapi-Customer'),
      customerQuota: customerQuotaOf(response),
    }
  }

  /**
   * The account's customers in a month, most invoices generated first, one
   * page at a time: pass the page's `nextCursor` as `cursor` for the next.
   * Needs a key that belongs to an account; a key bound to a customer sees
   * that customer only. Not counted.
   */
  async listCustomers(options: ListCustomersOptions = {}): Promise<CustomerPage> {
    const query = new URLSearchParams()
    if (options.month !== undefined) query.set('month', options.month)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const search = query.toString() === '' ? '' : `?${query.toString()}`
    const body = await this.customerCall(`/v1/customers${search}`, 'GET', options.signal)
    if (!isCustomerPage(body)) {
      throw new NormapiError('unexpected response shape from the customers service', 200, '')
    }
    return body
  }

  /** Every page of {@link listCustomers}, in order, for a month's billing run. */
  async *customers(
    options: Omit<ListCustomersOptions, 'cursor'> = {},
  ): AsyncGenerator<CustomerMonth, void, undefined> {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.listCustomers(
        cursor === undefined ? options : { ...options, cursor },
      )
      yield* page.customers
      cursor = page.nextCursor ?? undefined
      if (cursor !== undefined && seen.has(cursor)) return
      if (cursor !== undefined) seen.add(cursor)
    } while (cursor !== undefined)
  }

  /** One customer's month — zeros for a customer that has not called yet. */
  async getCustomer(customer: string, options: GetCustomerOptions = {}): Promise<CustomerMonth> {
    const search =
      options.month === undefined ? '' : `?${new URLSearchParams({ month: options.month }).toString()}`
    const body = await this.customerCall(
      `/v1/customers/${encodeURIComponent(customer)}${search}`,
      'GET',
      options.signal,
    )
    if (!isCustomerMonth(body)) {
      throw new NormapiError('unexpected response shape from the customers service', 200, '')
    }
    return body
  }

  /**
   * Sets or replaces the most invoices the customer may generate in a calendar
   * month (1 to 10,000,000), at once and for the whole month. Past it,
   * generation for that customer throws {@link CustomerQuotaExceededError}.
   */
  async setCustomerAllowance(
    customer: string,
    monthlyInvoices: number,
    options: CustomerAllowanceOptions = {},
  ): Promise<CustomerAllowance> {
    const body = await this.customerCall(
      `/v1/customers/${encodeURIComponent(customer)}/allowance`,
      'PUT',
      options.signal,
      { monthlyInvoices },
    )
    if (!isCustomerAllowance(body)) {
      throw new NormapiError('unexpected response shape from the customers service', 200, '')
    }
    return body
  }

  /** Removes the customer's ceiling; resolves whether there was one or not. */
  async clearCustomerAllowance(
    customer: string,
    options: CustomerAllowanceOptions = {},
  ): Promise<void> {
    await this.customerCall(
      `/v1/customers/${encodeURIComponent(customer)}/allowance`,
      'DELETE',
      options.signal,
    )
  }

  /**
   * A call to /v1/customers. Without X-Normapi-Customer, whatever the client
   * names: the path says which customer, and the header would count the call
   * for one.
   */
  private async customerCall(
    path: string,
    method: 'GET' | 'PUT' | 'DELETE',
    signal: AbortSignal | undefined,
    json?: unknown,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(json === undefined ? undefined : 'application/json', null),
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: signal ?? null,
    })
    if (response.status === 204) {
      return null
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw errorFor(response, body)
    }
    return body
  }
}

/** X-Normapi-Customer-Used and -Limit, present for a customer with a ceiling. */
function customerQuotaOf(response: Response): CustomerQuota | null {
  const used = Number.parseInt(response.headers.get('X-Normapi-Customer-Used') ?? '', 10)
  const limit = Number.parseInt(response.headers.get('X-Normapi-Customer-Limit') ?? '', 10)
  return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null
}

/**
 * X-Normapi-Ignored-Fields as a list. The service names at most 20 and then
 * "+N more", which stays in the list as it came.
 */
function ignoredFieldsOf(response: Response): readonly string[] {
  const header = response.headers.get('X-Normapi-Ignored-Fields')
  return header === null || header === '' ? [] : header.split(', ')
}

/** One-shot convenience against the public service. */
export async function validate(
  document: string | Uint8Array | ArrayBuffer,
  options: ValidateOptions & ClientOptions = {},
): Promise<ValidationResult> {
  return new Normapi(clientOptionsOf(options)).validate(document, options)
}

/** One-shot convenience against the public service. */
export async function parse(
  document: string | Uint8Array | ArrayBuffer,
  options: ParseOptions & ClientOptions = {},
): Promise<ParseResult> {
  return new Normapi(clientOptionsOf(options)).parse(document, options)
}

/** One-shot convenience against the public service. */
export async function explainRule(
  code: string,
  options: ExplainRuleOptions & ClientOptions = {},
): Promise<RuleInfo | null> {
  return new Normapi(clientOptionsOf(options)).explainRule(code, options)
}

/** One-shot convenience against the public service. */
export async function generateInvoice(
  invoice: InvoiceInput | ParsedInvoiceData,
  options: GenerateOptions & ClientOptions = {},
): Promise<GeneratedInvoice> {
  return new Normapi(clientOptionsOf(options)).generateInvoice(invoice, options)
}

/** One-shot convenience against the public service. */
export async function generateInvoicePdf(
  invoice: InvoiceInput | ParsedInvoiceData,
  options: GeneratePdfOptions & ClientOptions = {},
): Promise<GeneratedInvoicePdf> {
  return new Normapi(clientOptionsOf(options)).generateInvoicePdf(invoice, options)
}

function clientOptionsOf(options: ClientOptions): ClientOptions {
  return {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.customer === undefined ? {} : { customer: options.customer }),
  }
}

function toBody(document: string | Uint8Array | ArrayBuffer): string | Uint8Array<ArrayBuffer> {
  if (typeof document === 'string') {
    return document
  }
  if (document instanceof ArrayBuffer) {
    return new Uint8Array(document)
  }
  // Copied rather than passed through: fetch's BodyInit requires a plain
  // ArrayBuffer backing, and a Uint8Array<ArrayBufferLike> could be backed by
  // a SharedArrayBuffer. Invoices are a few kilobytes; the copy is free.
  const copy = new Uint8Array(document.byteLength)
  copy.set(document)
  return copy
}

/** Generation adds one refinement: a 422 with findings names the violated rules. */
function generationErrorFor(response: Response, body: unknown): NormapiError {
  if (response.status === 422 && isRecord(body) && Array.isArray(body['findings'])) {
    const findings: Finding[] = []
    for (const candidate of body['findings']) {
      const parsed = parseFinding(candidate)
      if (parsed !== null) {
        findings.push(parsed)
      }
    }
    const rulesetVersion =
      typeof body['rulesetVersion'] === 'string' ? body['rulesetVersion'] : ''
    return new InvoiceNotPermittedError(problemDetail(body), findings, rulesetVersion)
  }
  return errorFor(response, body)
}

function errorFor(response: Response, body: unknown): NormapiError {
  const detail = problemDetail(body)
  const retryAfter = retryAfterSeconds(response)
  if (response.status === 429 && isCustomerQuotaProblem(body)) {
    const resetsAt = typeof body.resetsAt === 'string' ? new Date(body.resetsAt) : null
    return new CustomerQuotaExceededError(
      detail,
      body.customer,
      body.used,
      body.limit,
      resetsAt !== null && Number.isNaN(resetsAt.getTime()) ? null : resetsAt,
      retryAfter,
    )
  }
  if (response.status === 429) {
    return new RateLimitError(detail, retryAfter)
  }
  if (response.status === 503) {
    return new ValidatorBusyError(detail, retryAfter)
  }
  return new NormapiError(
    detail.length > 0 ? detail : `request failed with status ${response.status}`,
    response.status,
    detail,
  )
}

function retryAfterSeconds(response: Response): number {
  const header = response.headers.get('Retry-After')
  if (header === null) {
    return 5
  }
  const parsed = Number.parseInt(header, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
}

function problemDetail(body: unknown): string {
  if (isRecord(body) && typeof body['detail'] === 'string') {
    return body['detail']
  }
  return ''
}

// ---------------------------------------------------------------------------
// Runtime verification of the response shape. Hand-rolled rather than pulled
// in as a dependency: this package promises zero runtime dependencies.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') {
    return value
  }
  return undefined
}

function intOrNull(value: unknown): number | null | undefined {
  if (value === null || (typeof value === 'number' && Number.isInteger(value))) {
    return value
  }
  return undefined
}

function parseFinding(value: unknown): Finding | null {
  if (!isRecord(value)) {
    return null
  }
  const { code, severity, text, origin } = value
  if (typeof code !== 'string' || typeof text !== 'string') {
    return null
  }
  if (severity !== 'ERROR' && severity !== 'WARNING' && severity !== 'INFORMATION') {
    return null
  }
  if (origin !== 'SCHEMA' && origin !== 'SCHEMATRON') {
    return null
  }
  const location = stringOrNull(value['location'])
  const line = intOrNull(value['line'])
  const column = intOrNull(value['column'])
  const test = stringOrNull(value['test'])
  const explanation = parseExplanation(value['explanation'])
  if (
    location === undefined ||
    line === undefined ||
    column === undefined ||
    test === undefined ||
    explanation === undefined
  ) {
    return null
  }
  return { code, severity, text, origin, location, line, column, test, explanation }
}

/**
 * Absent and null both mean "not explained": a deployment from before
 * explanations existed simply does not send the field. Anything else must be
 * a complete explanation whose link is an https page — it ends up in markup.
 */
function parseExplanation(value: unknown): Explanation | null | undefined {
  if (value === undefined || value === null) {
    return null
  }
  if (!isRecord(value)) {
    return undefined
  }
  const { meaning, cause, fix, url } = value
  if (
    typeof meaning !== 'string' ||
    typeof cause !== 'string' ||
    typeof fix !== 'string' ||
    typeof url !== 'string' ||
    !isHttpsUrl(url)
  ) {
    return undefined
  }
  return { meaning, cause, fix, url }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function parseRuleInfo(value: unknown): RuleInfo | null {
  if (!isRecord(value)) {
    return null
  }
  const { code, language } = value
  if (typeof code !== 'string' || (language !== 'de' && language !== 'en')) {
    return null
  }
  const explanation = parseExplanation(value['explanation'])
  if (explanation === null || explanation === undefined) {
    return null
  }
  return { code, language, explanation }
}

function parseValidationResult(value: unknown): ValidationResult | null {
  if (!isRecord(value)) {
    return null
  }
  const {
    acceptable,
    wellFormed,
    schemaValid,
    schematronValid,
    businessRulesEvaluated,
    rulesetVersion,
    findings,
  } = value
  if (
    typeof acceptable !== 'boolean' ||
    typeof wellFormed !== 'boolean' ||
    typeof schemaValid !== 'boolean' ||
    typeof schematronValid !== 'boolean' ||
    typeof businessRulesEvaluated !== 'boolean' ||
    typeof rulesetVersion !== 'string' ||
    !Array.isArray(findings)
  ) {
    return null
  }
  const scenario = stringOrNull(value['scenario'])
  if (scenario === undefined) {
    return null
  }
  const parsedFindings: Finding[] = []
  for (const finding of findings) {
    const parsed = parseFinding(finding)
    if (parsed === null) {
      return null
    }
    parsedFindings.push(parsed)
  }
  return {
    acceptable,
    wellFormed,
    schemaValid,
    schematronValid,
    businessRulesEvaluated,
    rulesetVersion,
    scenario,
    findings: parsedFindings,
  }
}

// The parse result. Its invoice is wide — some 150 fields — so it is checked
// by guards composed from a shape rather than written out field by field. A
// guard returns the payload it checked, unknown fields included, so a newer
// service that sends more still verifies. Each guard is declared against the
// exported interface: a field the interface has and the shape lacks fails to
// compile.

type Guard<T> = (value: unknown) => value is T

type Guarded<S> = { readonly [K in keyof S]: S[K] extends Guard<infer T> ? T : never }

function shape<S extends Record<string, Guard<unknown>>>(fields: S): Guard<Guarded<S>> {
  return (value: unknown): value is Guarded<S> =>
    isRecord(value) && Object.entries(fields).every(([key, guard]) => guard(value[key]))
}

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value: unknown): value is T | null => value === null || guard(value)
}

function listOf<T>(guard: Guard<T>): Guard<readonly T[]> {
  return (value: unknown): value is readonly T[] => Array.isArray(value) && value.every(guard)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const text = nullable(isString)
const amount = nullable(isFiniteNumber)

const isPeriod: Guard<ParsedPeriod> = shape({ startDate: text, endDate: text })

const isAddress: Guard<ParsedAddress> = shape({
  street: text,
  city: text,
  postcode: text,
  country: text,
})

const isParty: Guard<ParsedParty> = shape({
  name: text,
  identifier: text,
  vatId: text,
  taxNumber: text,
  electronicAddress: text,
  electronicAddressScheme: text,
  address: nullable(isAddress),
  contact: nullable(shape({ name: text, phone: text, email: text })),
  tradingName: text,
  registrationId: text,
  registrationIdScheme: text,
  legalInformation: text,
})

const isPayment: Guard<ParsedPayment> = shape({
  meansCode: text,
  iban: text,
  reference: text,
  meansText: text,
  accountName: text,
  bic: text,
  card: nullable(shape({ number: text, holder: text, network: text })),
  directDebit: nullable(
    shape({ mandateReference: text, creditorId: text, debitedAccount: text }),
  ),
})

const lineAdjustment = {
  amount,
  percent: amount,
  baseAmount: amount,
  reason: text,
  reasonCode: text,
}

const isLineAllowanceCharge: Guard<ParsedLineAllowanceCharge> = shape(lineAdjustment)

const isAllowanceCharge: Guard<ParsedAllowanceCharge> = shape({
  ...lineAdjustment,
  vatCategory: text,
  vatRate: amount,
  vatExemptionReason: text,
})

const isLine: Guard<ParsedLine> = shape({
  id: text,
  name: text,
  description: text,
  quantity: amount,
  unit: text,
  unitPrice: amount,
  vatCategory: text,
  vatRate: amount,
  vatExemptionReason: text,
  allowances: listOf(isLineAllowanceCharge),
  charges: listOf(isLineAllowanceCharge),
  period: nullable(isPeriod),
  orderLineReference: text,
  note: text,
  sellerItemId: text,
  buyerItemId: text,
  standardItemId: text,
  standardItemIdScheme: text,
  listPrice: amount,
  baseQuantity: amount,
})

const isInvoiceData: Guard<ParsedInvoiceData> = shape({
  invoiceNumber: text,
  issueDate: text,
  typeCode: isString,
  precedingInvoices: listOf(shape({ number: text, issueDate: text })),
  dueDate: text,
  deliveryDate: text,
  deliverTo: nullable(
    shape({
      name: text,
      locationId: text,
      locationIdScheme: text,
      address: nullable(isAddress),
    }),
  ),
  invoicePeriod: nullable(isPeriod),
  currency: text,
  buyerReference: text,
  orderReference: text,
  contractReference: text,
  projectReference: text,
  despatchAdviceReference: text,
  attachments: listOf(
    shape({
      id: text,
      description: text,
      filename: text,
      mimeCode: text,
      content: text,
      url: text,
    }),
  ),
  note: text,
  seller: nullable(isParty),
  buyer: nullable(isParty),
  payment: nullable(isPayment),
  paymentTerms: text,
  allowances: listOf(isAllowanceCharge),
  charges: listOf(isAllowanceCharge),
  prepaidAmount: amount,
  lines: listOf(isLine),
})

const isAdjustments = listOf(shape({ amount: text }))

const isStated: Guard<StatedAmounts> = shape({
  lineTotal: text,
  allowanceTotal: text,
  chargeTotal: text,
  netTotal: text,
  vatTotal: text,
  vatAccountingCurrency: text,
  vatTotalInAccountingCurrency: text,
  grossTotal: text,
  prepaidAmount: text,
  roundingAmount: text,
  amountDue: text,
  vatBreakdown: listOf(
    shape({
      category: text,
      rate: text,
      taxableAmount: text,
      vatAmount: text,
      exemptionReason: text,
      exemptionReasonCode: text,
    }),
  ),
  lines: listOf(
    shape({
      netAmount: text,
      priceDiscount: text,
      allowances: isAdjustments,
      charges: isAdjustments,
    }),
  ),
  allowances: isAdjustments,
  charges: isAdjustments,
})

const isSource: Guard<ParseSource> = shape({
  kind: (value: unknown): value is 'xml' | 'pdf' => value === 'xml' || value === 'pdf',
  attachment: text,
})

const isNotMapped = listOf(
  shape({
    path: isString,
    count: (value: unknown): value is number => Number.isInteger(value),
  }),
)

function parseParseResult(value: unknown): ParseResult | null {
  if (!isRecord(value)) {
    return null
  }
  const { syntax, documentKind, source, specificationId, businessProcess, profile } = value
  const { invoice, stated, notMapped } = value
  if (
    (syntax !== 'ubl' && syntax !== 'cii') ||
    (documentKind !== 'invoice' && documentKind !== 'creditNote') ||
    (profile !== null && profile !== 'xrechnung' && profile !== 'en16931') ||
    !text(specificationId) ||
    !text(businessProcess) ||
    !isSource(source) ||
    !isInvoiceData(invoice) ||
    !isStated(stated) ||
    !isNotMapped(notMapped)
  ) {
    return null
  }
  // The verdict goes through the same parsing validate() applies, explanations
  // and all; absent is as good as null for a deployment that predates it.
  const verdict = value['validation']
  const validation =
    verdict === null || verdict === undefined ? null : parseValidationResult(verdict)
  if (validation === null && verdict !== null && verdict !== undefined) {
    return null
  }
  return {
    syntax,
    documentKind,
    source,
    specificationId,
    businessProcess,
    profile,
    invoice,
    stated,
    notMapped,
    validation,
  }
}

// The customers' shapes, with the guards above.

const isCalls = (value: unknown): value is Readonly<Record<string, number>> =>
  isRecord(value) && Object.values(value).every(isFiniteNumber)

const isCustomerCounts: Guard<CustomerCounts> = shape({
  generated: isFiniteNumber,
  refused: isFiniteNumber,
  calls: isCalls,
})

const isCustomerMonth: Guard<CustomerMonth> = (value: unknown): value is CustomerMonth =>
  isCustomerCounts(value) &&
  shape({ customer: isString, monthlyInvoices: nullable(isFiniteNumber) })(value)

const isCustomerPage: Guard<CustomerPage> = shape({
  month: isString,
  customers: listOf(isCustomerMonth),
  withoutCustomer: nullable(isCustomerCounts),
  nextCursor: text,
})

const isCustomerAllowance: Guard<CustomerAllowance> = shape({
  customer: isString,
  monthlyInvoices: isFiniteNumber,
})

const isCustomerQuotaProblem = (
  value: unknown,
): value is { customer: string; used: number; limit: number; resetsAt?: unknown } =>
  isRecord(value) &&
  value['type'] === 'https://normapi.de/problems/customer-quota-exceeded' &&
  isString(value['customer']) &&
  isFiniteNumber(value['used']) &&
  isFiniteNumber(value['limit'])
