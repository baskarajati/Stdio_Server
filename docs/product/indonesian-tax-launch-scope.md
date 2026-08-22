# Stdio Indonesian tax launch scope

**Issue:** SOL-20  
**Proposal date:** 2026-08-21  
**Decision owner:** Founder  
**Scope owner:** CEO  
**Implementation owner after approval:** Backend Engineer

## Decision requested

Approve the launch/defer matrix in this document as the maximum Indonesian tax scope for Stdio v1.

This proposal gives interior and architecture studio owners a deterministic calculation aid. It does not determine a taxpayer's status, classify a transaction, prepare or submit a tax return, create a valid Faktur Pajak, or replace an accountant or tax adviser.

## 1. Existing decisions and contract boundary

The following decisions are already ratified or present in the current Stdio workspace:

1. Q15 on SOL-14: do not hire an Accounting Advisor now; apply Indonesian taxation only where current authoritative sources support a safe implementation. Unsupported or judgment-based rules are deferred. The founder approved this direction on 2026-08-21.
2. Money is stored as integer minor units in a `bigint`; JSON carries the amount as a string. Floating-point money is prohibited. Currency is mandatory on the workspace `Money` type and mismatched currencies cannot be combined.
3. Percentage calculations use exact rational factors. The money library supports `half-up` and `half-even`, with `half-up` currently the default. Allocations preserve the original total exactly.
4. The current native contract's A9 is an absence, not a rule. It carries some tax amounts, but defines no tax rate, tax jurisdiction, transaction eligibility, or rounding rule. Currency is absent from several invoice, quotation, finance-invoice, and purchase-order schemas.
5. A3 in the same review says money representation is mixed across contract inputs and outputs. The tax implementation must not build on those ambiguous shapes; the contract must first adopt the integer-money rule and mandatory currency.

Consequence: this proposal cannot authorize code against the current contract. Founder approval authorizes a later contract change proposal, not direct implementation.

## 2. Authoritative evidence register

Only Indonesian government primary sources are used for tax rules.

| Source | Status checked | Rule used |
|---|---|---|
| [PMK 131 Tahun 2024, DJP regulation text](https://www.pajak.go.id/index.php/id/peraturan/perlakuan-pajak-pertambahan-nilai-atas-impor-barang-kena-pajak-penyerahan-barang-kena) | Regulation dated 2024-12-31; effective 2025-01-01 | Article 3: for taxable goods other than the luxury goods in Article 2(3), taxable services, and listed cross-border uses, PPN is 12% multiplied by an `other value` tax base of 11/12 of import value, selling price, or consideration. Article 4 excludes supplies already governed by separate `other value` or specific-amount regimes. |
| [PMK 131 Tahun 2024, Kemenkeu JDIH summary](https://jdih.kemenkeu.go.id/dok/pmk-131-tahun-2024/summary) | Checked 2026-08-21 | Confirms scope, 12% x 11/12 calculation for the Article 3 category, exceptions, and effective date. |
| [PER-11/PJ/2025, DJP regulation text](https://pajak.go.id/id/peraturan/ketentuan-pelaporan-pajak-penghasilan-pajak-pertambahan-nilai-pajak-penjualan-atas-barang) | Official DJP catalogue marks it active; checked 2026-08-21 | Article 129: DPP and PPN shown on Faktur Pajak and specified documents are expressed in whole rupiah; decimals below 0.50 round down and decimals at or above 0.50 round up. |
| [PER-1/PJ/2025, DJP regulation text](https://www.pajak.go.id/id/peraturan-7) | Effective implementation guidance dated 2025-01-03 | Confirms Faktur Pajak is made by a PKP and specifies required invoice information. Used only to justify deferring Faktur Pajak generation and PKP eligibility decisions. |

Evidence was checked on 2026-08-21. Every verified preset must carry a `verified_at` date and be reviewed before launch and whenever a cited source is amended, revoked, or superseded.

## 3. Launch/defer matrix

| Capability or rule | Launch / defer | Effective date | Product behavior | Reason and evidence |
|---|---|---:|---|---|
| Exact money and tax arithmetic | **Launch** | All documents | Integer IDR; no floating point. Calculate with rational numerator/denominator values. Reject cross-currency aggregation. | Existing ratified Stdio money rule; prerequisite to avoid invoice drift. |
| `PPN_STANDARD_2025` preset | **Launch, opt-in** | 2025-01-01 onward | Statutory rate `12/100`; DPP factor `11/12`; calculate PPN as `12% × (11/12 × consideration)`, which is effectively 11%. Store the statutory rate and DPP factor separately. | PMK 131/2024 Article 3. |
| PPN applicability | **Launch as user confirmation, never inference** | Per document | Preset is hidden until the studio records `PKP status: confirmed by user`. On every use, user confirms: (a) the transaction is in Indonesia, (b) it falls within PMK 131 Article 3, and (c) no separately regulated DPP/specific-amount regime applies. | PKP and transaction classification are legal/eligibility judgments; PMK 131 Article 4 establishes exceptions. |
| PPN tax base | **Launch** | Per document | Use consideration after document-level discounts and before PPN. Group only lines to which the user applied the same verified preset. Do not infer taxable lines. | PMK 131 Article 3 uses selling price or consideration; line classification remains with the user. |
| IDR rounding | **Launch** | Documents dated on or after the applicable source date | For each document tax bucket: calculate exact DPP, round DPP to whole rupiah using half-up; calculate exact PPN from the rounded DPP; round PPN to whole rupiah using half-up. `0.49 → 0`, `0.50 → 1`. Never round each internal multiplication early. | PER-11/PJ/2025 Article 129 requires whole-rupiah half-up treatment for DPP and PPN displayed on tax documents. |
| Tax-inclusive prices | **Defer** | — | V1 supports tax-exclusive calculation only. Inclusive-price back-solving is unavailable for the verified preset. | PMK 131 supplies forward calculation; a back-solving and rounding allocation contract is not yet ratified. |
| Supplier-stated purchase tax | **Launch as recording only** | All documents | Store the tax label, DPP, tax amount, currency, supplier document reference, and user-entered source. Do not recalculate or claim it as creditable input tax. | Recording documentary facts is deterministic; credit eligibility is a judgment. |
| Custom tax line | **Launch, clearly unverified** | User-defined | User may enter a label, exact rational rate or fixed amount, and effective dates. UI labels it `Custom — not verified by Stdio`; it must never reuse an official preset code. | Supports real documents without presenting unsupported rules as Indonesian law. |
| Historical rule versions | **Launch** | Per preset version | Issued documents snapshot the entire rule and never change when a preset is updated. New source versions create a new rule version and effective-date interval. | Audit safety and reproducibility. |
| PKP registration or turnover threshold | **Defer** | — | No automatic eligibility, threshold alerts, or registration advice. Store user-confirmed PKP status, confirmation date, and optional evidence reference only. | Eligibility can depend on facts and current administrative rules; not safe without advice. |
| Exempt/non-taxable supplies and special DPP/specific-amount regimes | **Defer** | — | No automated classification or rate selection. Product shows `Stdio cannot verify this category`; user may record a custom amount. | PMK 131 Article 4 expressly carves out separate regimes. |
| Luxury goods PPN and PPnBM | **Defer** | — | No luxury classification, 12% luxury preset, or PPnBM calculation. | Classification requires other regulations and is outside Stdio's launch audience and minimal scope. |
| PPh withholding, including PPh 21/23/26/final regimes | **Defer** | — | No rate suggestion, withholding calculation, payee eligibility, gross-up, or certificate generation. A supplier-stated withheld amount may be recorded as an unverified document fact. | Applicable article, rate, base, residence, documentation, and exceptions require judgments not established by the sources above. |
| Input-tax credit eligibility | **Defer** | — | No `creditable` recommendation or VAT return position. | PMK 131 says crediting is subject to wider tax law; it is not a deterministic consequence of an invoice amount. |
| Faktur Pajak / Coretax generation or submission | **Defer** | — | Stdio invoices are commercial invoices only. Do not call them Faktur Pajak, allocate tax-invoice serials, sign, file, pay, or submit to DJP. | PER-1/PJ/2025 imposes PKP-specific content and process requirements beyond this scope. |
| Foreign-currency Indonesian tax calculation | **Defer** | — | Verified preset accepts IDR only. Foreign-currency commercial documents may record a user-provided IDR tax amount and exchange-rate evidence, but Stdio does not choose the tax exchange rate. | Applicable government exchange rate is date-sensitive; no safe static rule is proposed. |
| Returns, refunds, credit notes, bad-debt relief, corrections, penalties, and filing deadlines | **Defer** | — | Record external references and manual adjustments only; no tax outcome or deadline advice. | Fact patterns and procedural rules are outside the verified deterministic set. |

## 4. Configuration contract

Verified presets are centrally versioned product data, not tenant-editable settings. A tenant edit creates a `CUSTOM_UNVERIFIED` rule rather than changing an official preset.

Required rule fields:

- `rule_id`, `rule_version`, `status`
- `jurisdiction = ID`, `currency = IDR`, `tax_type = PPN`
- `effective_from`, nullable `effective_to`, `verified_at`
- `statutory_rate_numerator = 12`, `statutory_rate_denominator = 100`
- `dpp_factor_numerator = 11`, `dpp_factor_denominator = 12`
- `rounding_mode = HALF_UP`, `rounding_unit = 1 IDR`
- `round_dpp_before_tax = true`, `calculation_scope = DOCUMENT_TAX_BUCKET`
- primary-source URLs and source identifiers
- exclusions and required user-confirmation text

Threshold fields may exist in the generic rules engine but must be `null` for launch. No launch code may infer PKP eligibility from revenue.

## 5. Calculation and audit contract

For each issued quotation or commercial invoice using the verified preset, persist an immutable snapshot:

- commercial document ID, version, issue date, and status
- seller and buyer IDs as entered; seller's user-confirmed PKP status and confirmation timestamp
- rule ID/version, effective-date match, jurisdiction, currency, and source snapshot
- user ID, confirmation timestamp, and the exact applicability confirmation text accepted
- included line IDs, excluded line IDs, consideration before discount, discount, and post-discount base
- exact pre-round DPP numerator/denominator, rounded DPP in IDR
- exact pre-round PPN numerator/denominator, rounded PPN in IDR
- rounding mode, rounding stage, calculation scope, and final total
- any manual override amount, reason, actor, timestamp, and `CUSTOM_UNVERIFIED` marker
- reversal/supersession link; issued snapshots are never edited in place

Reference algorithm for `PPN_STANDARD_2025`:

```text
assert currency == IDR
assert issue_date >= 2025-01-01
assert user confirmed PKP status and Article 3 applicability

consideration = sum(selected lines) - allocated document discount
dpp_exact = consideration * 11 / 12
dpp_idr = round_half_up(dpp_exact, 1 IDR)
ppn_exact = dpp_idr * 12 / 100
ppn_idr = round_half_up(ppn_exact, 1 IDR)
total = consideration + ppn_idr
```

The implementation must include boundary tests at `x.49`, `x.50`, negative reversals, large integer values, discounts, mixed taxable/non-taxable user selections, and replay of historical rule versions.

## 6. Required product language

Before enabling the verified preset:

> Stdio calculates amounts from the rule and choices you provide. Stdio does not determine PKP status, taxability, exemptions, special regimes, filing duties, or eligibility. Confirm these choices against your records or a qualified professional.

When the preset cannot be safely applied:

> Stdio cannot verify the tax treatment for this transaction. Record an amount confirmed outside Stdio or continue without an automated tax calculation.

Commercial documents must say `PPN calculation` rather than `Faktur Pajak`. Stdio marketing and in-product copy must never say or imply that Stdio replaces an accountant or tax adviser.

## 7. Approval gate and next step

Founder confirmation is required on all five points:

1. Approve `PPN_STANDARD_2025` as the only verified Indonesian launch preset.
2. Approve explicit user confirmation instead of automatic PKP or transaction eligibility decisions.
3. Approve whole-IDR, two-stage half-up rounding at the document tax-bucket level.
4. Approve every defer row and the required disclaimer language.
5. Approve IDR-only verified calculations and immutable historical rule snapshots.

Only after confirmation may the CEO create a Backend Engineer implementation issue. That issue must first propose the native/API contract changes needed to resolve A3/A9 and receive the normal contract review; it must not start by writing tax calculation code.
