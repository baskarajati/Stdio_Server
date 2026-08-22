# SOL-25 contract change proposal — revision 14 draft

**Parent issue:** SOL-25  
**Correction issue:** SOL-71  
**Status:** Draft. It is not ready for review or implementation.  
**Scope:** Contract-proposal work only. This document changes no OpenAPI YAML, server, database, web, Swift, or tests.

## 1. Gate and preserved launch boundary

This draft closes the revision-13 defects recorded by SOL-70. The founder must first resolve the representation conflict in section 2. The Backend Engineer must then replace that section with the founder-approved clause. Only then may this exact body receive a fresh Founding Engineer verdict.

`PPN_STANDARD_2025` remains the only verified preset. It is centrally versioned and tenant-immutable. A tenant change creates a `CUSTOM_UNVERIFIED` rule.

Verified calculation is IDR-only. It requires all four conditions below:

- The rule version matches the server-owned document issue date.
- The studio PKP status is confirmed by the user.
- The user confirms PMK 131 Article 3 applicability.
- The user confirms that no separate regime applies.

The verified rule is `12/100` statutory PPN with an `11/12` DPP factor. It uses document-tax-bucket scope and two-stage whole-IDR half-up rounding.

The product says `PPN calculation`. It includes the approved disclaimer. It does not say `Faktur Pajak`.

This proposal adds no tax category, special regime, PPnBM, PPh, input-credit, Faktur Pajak, Coretax, exchange-rate calculation, return, correction, penalty, or deadline behavior.

## 2. Founder-owned money representation decision

SOL-70 found a conflict between the approved scope's `bigint` wording and the completed `numeric(20,2)` schema. The founder owns this decision. This draft does not choose a final representation clause.

The founder must accept or reject this proposed separation:

- PostgreSQL persistence uses `numeric(20,2)`.
- Backend and core arithmetic use exact integer minor units with `bigint`.
- No calculation uses floating point.
- JSON responses use canonical two-decimal strings.
- Requests retain the ratified exact `MoneyInput` parsing rules.

Do not publish revision 14 as ready for review until the founder records that decision on SOL-25. This document otherwise states the complete revision-14 correction.

## 3. Shared primitives

`MoneyOutput` is the existing canonical two-decimal response string. `MoneyInput` retains the ratified exact request parsing rule. Neither is a floating-point contract.

`Null` below means exactly `type: "null"`. A required null field must be present with JSON `null`. An omitted field fails validation.

```yaml
RationalInteger:
  type: string
  pattern: '^-?[0-9]+$'

PositiveRationalInteger:
  type: string
  pattern: '^[1-9][0-9]*$'

CurrencyCode:
  type: string
  pattern: '^[A-Z]{3}$'

NonIDRCurrencyCode:
  allOf:
    - $ref: '#/components/schemas/CurrencyCode'
    - not: { const: IDR }

CustomTaxRuleCode:
  type: string
  minLength: 1
  not: { const: PPN_STANDARD_2025 }

Null:
  type: 'null'

ExchangeRateEvidence:
  description: >-
    Documentary evidence entered by the user. The server stores this value
    verbatim. The server does not calculate, select, normalize, compare, or
    validate an exchange rate.
  oneOf:
    - type: string
      minLength: 1
    - type: object
      minProperties: 1
      additionalProperties: true
```

The only exchange-rate evidence request location is `TaxApplicationCustomRecording.manualOverride.exchangeRateEvidence`. The only immutable evidence location is `TaxSnapshotCustomRecording*.manualOverride.exchangeRateEvidence`.

No other request, rule, result, or snapshot field may carry exchange-rate evidence, a selected rate, a normalized rate, or a derived rate.

## 4. Strict calculation-result modes

`TaxCalculationResult` is a strict `oneOf`. The server returns it from `POST /tax-calculations`. Clients never submit it.

```yaml
TaxCalculationResult:
  oneOf:
    - $ref: '#/components/schemas/TaxCalculationResultRationalRate'
    - $ref: '#/components/schemas/TaxCalculationResultFixedAmount'

TaxCalculationResultRationalRate:
  type: object
  additionalProperties: false
  required:
    - calculationMode
    - ruleId
    - ruleVersion
    - ruleStatus
    - documentCurrency
    - considerationBeforeDiscount
    - discount
    - taxableBase
    - fixedTaxAmount
    - dppExactNumerator
    - dppExactDenominator
    - dppRounded
    - ppnExactNumerator
    - ppnExactDenominator
    - ppnRounded
    - roundingStage
    - total
  properties:
    calculationMode: { const: RATIONAL_RATE }
    ruleId: { type: string, minLength: 1 }
    ruleVersion: { type: integer, minimum: 1 }
    ruleStatus: { enum: [VERIFIED, CUSTOM_UNVERIFIED] }
    documentCurrency: { const: IDR }
    considerationBeforeDiscount: { $ref: '#/components/schemas/MoneyOutput' }
    discount: { $ref: '#/components/schemas/MoneyOutput' }
    taxableBase: { $ref: '#/components/schemas/MoneyOutput' }
    fixedTaxAmount: { $ref: '#/components/schemas/Null' }
    dppExactNumerator: { $ref: '#/components/schemas/RationalInteger' }
    dppExactDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
    dppRounded: { $ref: '#/components/schemas/MoneyOutput' }
    ppnExactNumerator: { $ref: '#/components/schemas/RationalInteger' }
    ppnExactDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
    ppnRounded: { $ref: '#/components/schemas/MoneyOutput' }
    roundingStage: { const: DPP_THEN_PPN }
    total: { $ref: '#/components/schemas/MoneyOutput' }

TaxCalculationResultFixedAmount:
  type: object
  additionalProperties: false
  required:
    - calculationMode
    - ruleId
    - ruleVersion
    - ruleStatus
    - documentCurrency
    - considerationBeforeDiscount
    - discount
    - taxableBase
    - fixedTaxAmount
    - dppExactNumerator
    - dppExactDenominator
    - dppRounded
    - ppnExactNumerator
    - ppnExactDenominator
    - ppnRounded
    - roundingStage
    - total
  properties:
    calculationMode: { const: FIXED_AMOUNT }
    ruleId: { type: string, minLength: 1 }
    ruleVersion: { type: integer, minimum: 1 }
    ruleStatus: { const: CUSTOM_UNVERIFIED }
    documentCurrency: { const: IDR }
    considerationBeforeDiscount: { $ref: '#/components/schemas/MoneyOutput' }
    discount: { $ref: '#/components/schemas/MoneyOutput' }
    taxableBase: { $ref: '#/components/schemas/MoneyOutput' }
    fixedTaxAmount: { $ref: '#/components/schemas/MoneyOutput' }
    dppExactNumerator: { $ref: '#/components/schemas/Null' }
    dppExactDenominator: { $ref: '#/components/schemas/Null' }
    dppRounded: { $ref: '#/components/schemas/Null' }
    ppnExactNumerator: { $ref: '#/components/schemas/Null' }
    ppnExactDenominator: { $ref: '#/components/schemas/Null' }
    ppnRounded: { $ref: '#/components/schemas/Null' }
    roundingStage: { $ref: '#/components/schemas/Null' }
    total: { $ref: '#/components/schemas/MoneyOutput' }
```

Every `FIXED_AMOUNT` result field named below is required and exactly null: `dppRounded`, `ppnRounded`, `dppExactNumerator`, `dppExactDenominator`, `ppnExactNumerator`, `ppnExactDenominator`, and `roundingStage`. A non-null or omitted value fails schema validation.

## 5. Strict `TaxRule` catalog modes

`TaxRule` is a strict, disjoint `oneOf`. `additionalProperties: false` on each leaf prevents a mixed rule. A verified rule cannot be tenant-edited. A custom code cannot reuse an official preset code.

```yaml
TaxRule:
  oneOf:
    - $ref: '#/components/schemas/TaxRuleVerifiedRational'
    - $ref: '#/components/schemas/TaxRuleCustomRational'
    - $ref: '#/components/schemas/TaxRuleCustomFixed'

TaxRuleVerifiedRational:
  type: object
  additionalProperties: false
  required: [id, version, status, code, jurisdiction, taxType, currency,
    calculationMode, effectiveFrom, effectiveTo, verifiedAt,
    statutoryRateNumerator, statutoryRateDenominator, dppFactorNumerator,
    dppFactorDenominator, fixedAmount, roundingMode, roundingUnitMinor,
    roundDppBeforeTax, roundingStage, calculationScope, sources,
    applicabilityConfirmationText, disclaimerText, entityVersion]
  properties:
    id: { type: string, minLength: 1 }
    version: { type: integer, minimum: 1 }
    status: { const: VERIFIED }
    code: { const: PPN_STANDARD_2025 }
    jurisdiction: { const: ID }
    taxType: { const: PPN }
    currency: { const: IDR }
    calculationMode: { const: RATIONAL_RATE }
    effectiveFrom: { type: string, format: date }
    effectiveTo: { oneOf: [{ type: string, format: date }, { $ref: '#/components/schemas/Null' }] }
    verifiedAt: { type: string, format: date }
    statutoryRateNumerator: { const: '12' }
    statutoryRateDenominator: { const: '100' }
    dppFactorNumerator: { const: '11' }
    dppFactorDenominator: { const: '12' }
    fixedAmount: { $ref: '#/components/schemas/Null' }
    roundingMode: { const: HALF_UP }
    roundingUnitMinor: { const: 100 }
    roundDppBeforeTax: { const: true }
    roundingStage: { const: DPP_THEN_PPN }
    calculationScope: { const: DOCUMENT_TAX_BUCKET }
    sources: { type: array, minItems: 1, items: { $ref: '#/components/schemas/TaxRuleSource' } }
    applicabilityConfirmationText: { type: string, minLength: 1 }
    disclaimerText: { type: string, minLength: 1 }
    entityVersion: { type: string, minLength: 1 }

TaxRuleCustomRational:
  type: object
  additionalProperties: false
  required: [id, version, status, code, jurisdiction, taxType, currency,
    calculationMode, effectiveFrom, effectiveTo, verifiedAt,
    statutoryRateNumerator, statutoryRateDenominator, dppFactorNumerator,
    dppFactorDenominator, fixedAmount, roundingMode, roundingUnitMinor,
    roundDppBeforeTax, roundingStage, calculationScope, sources,
    disclaimerText, entityVersion]
  properties:
    id: { type: string, minLength: 1 }
    version: { type: integer, minimum: 1 }
    status: { const: CUSTOM_UNVERIFIED }
    code: { $ref: '#/components/schemas/CustomTaxRuleCode' }
    jurisdiction: { const: ID }
    taxType: { const: PPN }
    currency: { const: IDR }
    calculationMode: { const: RATIONAL_RATE }
    effectiveFrom: { type: string, format: date }
    effectiveTo: { oneOf: [{ type: string, format: date }, { $ref: '#/components/schemas/Null' }] }
    verifiedAt: { $ref: '#/components/schemas/Null' }
    statutoryRateNumerator: { $ref: '#/components/schemas/PositiveRationalInteger' }
    statutoryRateDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
    dppFactorNumerator: { $ref: '#/components/schemas/PositiveRationalInteger' }
    dppFactorDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
    fixedAmount: { $ref: '#/components/schemas/Null' }
    roundingMode: { const: HALF_UP }
    roundingUnitMinor: { const: 100 }
    roundDppBeforeTax: { const: true }
    roundingStage: { const: DPP_THEN_PPN }
    calculationScope: { const: DOCUMENT_TAX_BUCKET }
    sources: { type: array, minItems: 1, items: { $ref: '#/components/schemas/TaxRuleSource' } }
    disclaimerText: { type: string, minLength: 1 }
    entityVersion: { type: string, minLength: 1 }

TaxRuleCustomFixed:
  type: object
  additionalProperties: false
  required: [id, version, status, code, jurisdiction, taxType, currency,
    calculationMode, effectiveFrom, effectiveTo, verifiedAt,
    statutoryRateNumerator, statutoryRateDenominator, dppFactorNumerator,
    dppFactorDenominator, fixedAmount, roundingMode, roundingUnitMinor,
    roundDppBeforeTax, roundingStage, calculationScope, sources,
    disclaimerText, entityVersion]
  properties:
    id: { type: string, minLength: 1 }
    version: { type: integer, minimum: 1 }
    status: { const: CUSTOM_UNVERIFIED }
    code: { $ref: '#/components/schemas/CustomTaxRuleCode' }
    jurisdiction: { const: ID }
    taxType: { const: PPN }
    currency: { const: IDR }
    calculationMode: { const: FIXED_AMOUNT }
    effectiveFrom: { type: string, format: date }
    effectiveTo: { oneOf: [{ type: string, format: date }, { $ref: '#/components/schemas/Null' }] }
    verifiedAt: { $ref: '#/components/schemas/Null' }
    statutoryRateNumerator: { $ref: '#/components/schemas/Null' }
    statutoryRateDenominator: { $ref: '#/components/schemas/Null' }
    dppFactorNumerator: { $ref: '#/components/schemas/Null' }
    dppFactorDenominator: { $ref: '#/components/schemas/Null' }
    fixedAmount: { $ref: '#/components/schemas/MoneyOutput' }
    roundingMode: { const: HALF_UP }
    roundingUnitMinor: { const: 100 }
    roundDppBeforeTax: { $ref: '#/components/schemas/Null' }
    roundingStage: { $ref: '#/components/schemas/Null' }
    calculationScope: { const: DOCUMENT_TAX_BUCKET }
    sources: { type: array, minItems: 1, items: { $ref: '#/components/schemas/TaxRuleSource' } }
    disclaimerText: { type: string, minLength: 1 }
    entityVersion: { type: string, minLength: 1 }
```

The verified leaf requires the approved `12/100`, `11/12`, `true`, and `DPP_THEN_PPN` constants. The custom leaves cannot reuse `PPN_STANDARD_2025`. The custom rational leaf requires all four rational constants and the same two-stage rounding shape. The fixed leaf requires every rational value, `roundDppBeforeTax`, and `roundingStage` as present null values.

## 6. Strict issue input modes and one acknowledgment source

`TaxApplicationInput` is a strict `oneOf`. It supports a verified rational calculation, a custom rule calculation, or a custom recording. `manualOverride` is only valid in the recording branch.

```yaml
TaxApplicationInput:
  oneOf:
    - $ref: '#/components/schemas/TaxApplicationVerifiedRational'
    - $ref: '#/components/schemas/TaxApplicationCustomRule'
    - $ref: '#/components/schemas/TaxApplicationCustomRecording'

TaxApplicationVerifiedRational:
  type: object
  additionalProperties: false
  required: [ruleId, ruleVersion, documentCurrency, lineSelections, confirmation]
  properties:
    ruleId: { type: string, minLength: 1 }
    ruleVersion: { oneOf: [{ type: integer, minimum: 1 }, { $ref: '#/components/schemas/Null' }] }
    documentCurrency: { const: IDR }
    lineSelections: { $ref: '#/components/schemas/TaxLineSelections' }
    confirmation: { $ref: '#/components/schemas/TaxApplicabilityConfirmation' }

TaxApplicationCustomRule:
  type: object
  additionalProperties: false
  required: [ruleId, ruleVersion, documentCurrency, lineSelections, customRuleAcknowledgment]
  properties:
    ruleId: { type: string, minLength: 1 }
    ruleVersion: { oneOf: [{ type: integer, minimum: 1 }, { $ref: '#/components/schemas/Null' }] }
    documentCurrency: { const: IDR }
    lineSelections: { $ref: '#/components/schemas/TaxLineSelections' }
    customRuleAcknowledgment: { $ref: '#/components/schemas/CustomTaxRuleAcknowledgment' }

TaxApplicationCustomRecording:
  type: object
  additionalProperties: false
  required: [lineSelections, manualOverride, recordingAcknowledgment]
  properties:
    lineSelections: { $ref: '#/components/schemas/TaxLineSelections' }
    manualOverride: { $ref: '#/components/schemas/TaxManualOverrideInput' }
    recordingAcknowledgment: { $ref: '#/components/schemas/CustomTaxRecordingAcknowledgment' }

TaxLineSelections:
  type: array
  minItems: 1
  items:
    type: object
    additionalProperties: false
    required: [lineId, selected]
    properties:
      lineId: { type: string, minLength: 1 }
      selected: { type: boolean }

TaxApplicabilityConfirmation:
  type: object
  additionalProperties: false
  required: [transactionInIndonesia, fallsWithinPmk131Article3,
    noSeparateRegimeApplies, pkpStatusConfirmed, acceptedText]
  properties:
    transactionInIndonesia: { const: true }
    fallsWithinPmk131Article3: { const: true }
    noSeparateRegimeApplies: { const: true }
    pkpStatusConfirmed: { const: true }
    acceptedText: { type: string, minLength: 1 }

CustomTaxRuleAcknowledgment:
  type: object
  additionalProperties: false
  required: [customUnverified, acceptedText]
  properties:
    customUnverified: { const: true }
    acceptedText: { type: string, minLength: 1 }

CustomTaxRecordingAcknowledgment:
  type: object
  additionalProperties: false
  required: [recordedOutsideStdio, notVerifiedTreatment, acceptedText]
  properties:
    recordedOutsideStdio: { const: true }
    notVerifiedTreatment: { const: true }
    acceptedText: { type: string, minLength: 1 }

TaxManualOverrideInput:
  oneOf:
    - $ref: '#/components/schemas/TaxManualOverrideInputIDR'
    - $ref: '#/components/schemas/TaxManualOverrideInputNonIDR'

TaxManualOverrideInputIDR:
  type: object
  additionalProperties: false
  required: [label, amount, taxAmountCurrency, documentCurrency, reason,
    source, lineIds, exchangeRateEvidence]
  properties:
    label: { type: string, minLength: 1 }
    amount: { $ref: '#/components/schemas/MoneyInput' }
    taxAmountCurrency: { const: IDR }
    documentCurrency: { const: IDR }
    reason: { type: string, minLength: 1 }
    source: { type: string, minLength: 1 }
    lineIds: { type: array, minItems: 1, items: { type: string, minLength: 1 } }
    exchangeRateEvidence: { $ref: '#/components/schemas/Null' }

TaxManualOverrideInputNonIDR:
  type: object
  additionalProperties: false
  required: [label, amount, taxAmountCurrency, documentCurrency, reason,
    source, lineIds, exchangeRateEvidence]
  properties:
    label: { type: string, minLength: 1 }
    amount: { $ref: '#/components/schemas/MoneyInput' }
    taxAmountCurrency: { const: IDR }
    documentCurrency: { $ref: '#/components/schemas/NonIDRCurrencyCode' }
    reason: { type: string, minLength: 1 }
    source: { type: string, minLength: 1 }
    lineIds: { type: array, minItems: 1, items: { type: string, minLength: 1 } }
    exchangeRateEvidence: { $ref: '#/components/schemas/ExchangeRateEvidence' }
```

The custom recording branch does not contain a rule ID, rule version, calculation mode, calculated total, or verified applicability confirmation. `lineSelections` must equal `manualOverride.lineIds` after duplicate removal. The server rejects a difference with `422 TAX_OVERRIDE_LINE_INVALID`.

The recording acknowledgment is the only source of a recording snapshot's `acceptedConfirmationText`. The server copies `recordingAcknowledgment.acceptedText` byte-for-byte into that field. A reason, source, or any other free-form value must never populate `acceptedConfirmationText`.

## 7. Strict immutable `TaxSnapshot` modes

`TaxSnapshot` is a strict and disjoint `oneOf`. The server writes it in the same transaction as document issue. Clients cannot submit it. A correction creates a new snapshot and links it. It never edits an issued snapshot in place.

`TaxSnapshotCustomRecording` is one logical recording shape. It has two disjoint leaves only to enforce the IDR and non-IDR evidence rules.

```yaml
TaxSnapshot:
  oneOf:
    - $ref: '#/components/schemas/TaxSnapshotVerifiedRational'
    - $ref: '#/components/schemas/TaxSnapshotCustomRational'
    - $ref: '#/components/schemas/TaxSnapshotCustomFixed'
    - $ref: '#/components/schemas/TaxSnapshotCustomRecordingIDR'
    - $ref: '#/components/schemas/TaxSnapshotCustomRecordingNonIDR'

TaxSnapshotAuditBase:
  type: object
  required: [snapshotId, documentId, documentVersion, documentIssueDate,
    documentStatus, taxType, jurisdiction, includedLineIds,
    excludedLineIds, confirmedById, confirmedAt, acceptedConfirmationText,
    supersededBySnapshotId, supersessionReason]
  properties:
    snapshotId: { type: string, minLength: 1 }
    documentId: { type: string, minLength: 1 }
    documentVersion: { type: string, minLength: 1 }
    documentIssueDate: { type: string, format: date }
    documentStatus: { type: string, minLength: 1 }
    taxType: { const: PPN }
    jurisdiction: { const: ID }
    includedLineIds: { type: array, minItems: 1, items: { type: string, minLength: 1 } }
    excludedLineIds: { type: array, items: { type: string, minLength: 1 } }
    confirmedById: { type: string, minLength: 1 }
    confirmedAt: { type: string, format: date-time }
    acceptedConfirmationText: { type: string, minLength: 1 }
    supersededBySnapshotId: { oneOf: [{ type: string, minLength: 1 }, { $ref: '#/components/schemas/Null' }] }
    supersessionReason: { oneOf: [{ type: string, minLength: 1 }, { $ref: '#/components/schemas/Null' }] }

TaxSnapshotVerifiedRational:
  allOf:
    - $ref: '#/components/schemas/TaxSnapshotAuditBase'
    - type: object
      required: [documentCurrency, ruleId, ruleVersion, ruleCode, ruleStatus, calculationMode,
        effectiveDateMatched, verifiedAt, statutoryRateNumerator,
        statutoryRateDenominator, dppFactorNumerator, dppFactorDenominator,
        fixedAmount, roundDppBeforeTax, roundingStage, roundingMode,
        roundingUnitMinor, calculationScope, sources,
        considerationBeforeDiscount, discount, taxableBase,
        dppExactNumerator, dppExactDenominator, dppRounded,
        ppnExactNumerator, ppnExactDenominator, ppnRounded, total,
        manualOverride]
      properties:
        documentCurrency: { const: IDR }
        ruleId: { type: string, minLength: 1 }
        ruleVersion: { type: integer, minimum: 1 }
        ruleCode: { const: PPN_STANDARD_2025 }
        ruleStatus: { const: VERIFIED }
        calculationMode: { const: RATIONAL_RATE }
        effectiveDateMatched: { const: true }
        verifiedAt: { type: string, format: date }
        statutoryRateNumerator: { const: '12' }
        statutoryRateDenominator: { const: '100' }
        dppFactorNumerator: { const: '11' }
        dppFactorDenominator: { const: '12' }
        fixedAmount: { $ref: '#/components/schemas/Null' }
        roundDppBeforeTax: { const: true }
        roundingStage: { const: DPP_THEN_PPN }
        roundingMode: { const: HALF_UP }
        roundingUnitMinor: { const: 100 }
        calculationScope: { const: DOCUMENT_TAX_BUCKET }
        sources: { type: array, minItems: 1, items: { $ref: '#/components/schemas/TaxRuleSource' } }
        considerationBeforeDiscount: { $ref: '#/components/schemas/MoneyOutput' }
        discount: { $ref: '#/components/schemas/MoneyOutput' }
        taxableBase: { $ref: '#/components/schemas/MoneyOutput' }
        dppExactNumerator: { $ref: '#/components/schemas/RationalInteger' }
        dppExactDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        dppRounded: { $ref: '#/components/schemas/MoneyOutput' }
        ppnExactNumerator: { $ref: '#/components/schemas/RationalInteger' }
        ppnExactDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        ppnRounded: { $ref: '#/components/schemas/MoneyOutput' }
        total: { $ref: '#/components/schemas/MoneyOutput' }
        manualOverride: { $ref: '#/components/schemas/Null' }
  unevaluatedProperties: false

TaxSnapshotCustomRational:
  allOf:
    - $ref: '#/components/schemas/TaxSnapshotAuditBase'
    - type: object
      required: [documentCurrency, ruleId, ruleVersion, ruleCode, ruleStatus, calculationMode,
        effectiveDateMatched, verifiedAt, statutoryRateNumerator,
        statutoryRateDenominator, dppFactorNumerator, dppFactorDenominator,
        fixedAmount, roundDppBeforeTax, roundingStage, roundingMode,
        roundingUnitMinor, calculationScope, sources,
        considerationBeforeDiscount, discount, taxableBase,
        dppExactNumerator, dppExactDenominator, dppRounded,
        ppnExactNumerator, ppnExactDenominator, ppnRounded, total,
        manualOverride]
      properties:
        documentCurrency: { const: IDR }
        ruleId: { type: string, minLength: 1 }
        ruleVersion: { type: integer, minimum: 1 }
        ruleCode: { $ref: '#/components/schemas/CustomTaxRuleCode' }
        ruleStatus: { const: CUSTOM_UNVERIFIED }
        calculationMode: { const: RATIONAL_RATE }
        effectiveDateMatched: { $ref: '#/components/schemas/Null' }
        verifiedAt: { $ref: '#/components/schemas/Null' }
        statutoryRateNumerator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        statutoryRateDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        dppFactorNumerator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        dppFactorDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        fixedAmount: { $ref: '#/components/schemas/Null' }
        roundDppBeforeTax: { const: true }
        roundingStage: { const: DPP_THEN_PPN }
        roundingMode: { const: HALF_UP }
        roundingUnitMinor: { const: 100 }
        calculationScope: { const: DOCUMENT_TAX_BUCKET }
        sources: { type: array, minItems: 1, items: { $ref: '#/components/schemas/TaxRuleSource' } }
        considerationBeforeDiscount: { $ref: '#/components/schemas/MoneyOutput' }
        discount: { $ref: '#/components/schemas/MoneyOutput' }
        taxableBase: { $ref: '#/components/schemas/MoneyOutput' }
        dppExactNumerator: { $ref: '#/components/schemas/RationalInteger' }
        dppExactDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        dppRounded: { $ref: '#/components/schemas/MoneyOutput' }
        ppnExactNumerator: { $ref: '#/components/schemas/RationalInteger' }
        ppnExactDenominator: { $ref: '#/components/schemas/PositiveRationalInteger' }
        ppnRounded: { $ref: '#/components/schemas/MoneyOutput' }
        total: { $ref: '#/components/schemas/MoneyOutput' }
        manualOverride: { $ref: '#/components/schemas/Null' }
  unevaluatedProperties: false

TaxSnapshotCustomFixed:
  allOf:
    - $ref: '#/components/schemas/TaxSnapshotAuditBase'
    - type: object
      required: [documentCurrency, ruleId, ruleVersion, ruleCode, ruleStatus, calculationMode,
        effectiveDateMatched, verifiedAt, statutoryRateNumerator,
        statutoryRateDenominator, dppFactorNumerator, dppFactorDenominator,
        fixedAmount, roundDppBeforeTax, roundingStage, roundingMode,
        roundingUnitMinor, calculationScope, sources,
        considerationBeforeDiscount, discount, taxableBase,
        dppExactNumerator, dppExactDenominator, dppRounded,
        ppnExactNumerator, ppnExactDenominator, ppnRounded, total,
        manualOverride]
      properties:
        documentCurrency: { const: IDR }
        ruleId: { type: string, minLength: 1 }
        ruleVersion: { type: integer, minimum: 1 }
        ruleCode: { $ref: '#/components/schemas/CustomTaxRuleCode' }
        ruleStatus: { const: CUSTOM_UNVERIFIED }
        calculationMode: { const: FIXED_AMOUNT }
        effectiveDateMatched: { $ref: '#/components/schemas/Null' }
        verifiedAt: { $ref: '#/components/schemas/Null' }
        statutoryRateNumerator: { $ref: '#/components/schemas/Null' }
        statutoryRateDenominator: { $ref: '#/components/schemas/Null' }
        dppFactorNumerator: { $ref: '#/components/schemas/Null' }
        dppFactorDenominator: { $ref: '#/components/schemas/Null' }
        fixedAmount: { $ref: '#/components/schemas/MoneyOutput' }
        roundDppBeforeTax: { $ref: '#/components/schemas/Null' }
        roundingStage: { $ref: '#/components/schemas/Null' }
        roundingMode: { const: HALF_UP }
        roundingUnitMinor: { const: 100 }
        calculationScope: { const: DOCUMENT_TAX_BUCKET }
        sources: { type: array, minItems: 1, items: { $ref: '#/components/schemas/TaxRuleSource' } }
        considerationBeforeDiscount: { $ref: '#/components/schemas/MoneyOutput' }
        discount: { $ref: '#/components/schemas/MoneyOutput' }
        taxableBase: { $ref: '#/components/schemas/MoneyOutput' }
        dppExactNumerator: { $ref: '#/components/schemas/Null' }
        dppExactDenominator: { $ref: '#/components/schemas/Null' }
        dppRounded: { $ref: '#/components/schemas/Null' }
        ppnExactNumerator: { $ref: '#/components/schemas/Null' }
        ppnExactDenominator: { $ref: '#/components/schemas/Null' }
        ppnRounded: { $ref: '#/components/schemas/Null' }
        total: { $ref: '#/components/schemas/MoneyOutput' }
        manualOverride: { $ref: '#/components/schemas/Null' }
  unevaluatedProperties: false

TaxSnapshotCustomRecordingIDR:
  allOf:
    - $ref: '#/components/schemas/TaxSnapshotAuditBase'
    - type: object
      required: [ruleId, ruleVersion, ruleCode, ruleStatus, calculationMode,
        effectiveDateMatched, verifiedAt, statutoryRateNumerator,
        statutoryRateDenominator, dppFactorNumerator, dppFactorDenominator,
        fixedAmount, roundDppBeforeTax, roundingStage, roundingMode,
        roundingUnitMinor, calculationScope, sources,
        considerationBeforeDiscount, discount, taxableBase,
        dppExactNumerator, dppExactDenominator, dppRounded,
        ppnExactNumerator, ppnExactDenominator, ppnRounded, total,
        manualOverride]
      properties:
        ruleId: { $ref: '#/components/schemas/Null' }
        ruleVersion: { $ref: '#/components/schemas/Null' }
        ruleCode: { $ref: '#/components/schemas/Null' }
        ruleStatus: { const: CUSTOM_UNVERIFIED }
        calculationMode: { $ref: '#/components/schemas/Null' }
        effectiveDateMatched: { $ref: '#/components/schemas/Null' }
        verifiedAt: { $ref: '#/components/schemas/Null' }
        statutoryRateNumerator: { $ref: '#/components/schemas/Null' }
        statutoryRateDenominator: { $ref: '#/components/schemas/Null' }
        dppFactorNumerator: { $ref: '#/components/schemas/Null' }
        dppFactorDenominator: { $ref: '#/components/schemas/Null' }
        fixedAmount: { $ref: '#/components/schemas/Null' }
        roundDppBeforeTax: { $ref: '#/components/schemas/Null' }
        roundingStage: { $ref: '#/components/schemas/Null' }
        roundingMode: { $ref: '#/components/schemas/Null' }
        roundingUnitMinor: { $ref: '#/components/schemas/Null' }
        calculationScope: { $ref: '#/components/schemas/Null' }
        sources: { $ref: '#/components/schemas/Null' }
        considerationBeforeDiscount: { $ref: '#/components/schemas/Null' }
        discount: { $ref: '#/components/schemas/Null' }
        taxableBase: { $ref: '#/components/schemas/Null' }
        dppExactNumerator: { $ref: '#/components/schemas/Null' }
        dppExactDenominator: { $ref: '#/components/schemas/Null' }
        dppRounded: { $ref: '#/components/schemas/Null' }
        ppnExactNumerator: { $ref: '#/components/schemas/Null' }
        ppnExactDenominator: { $ref: '#/components/schemas/Null' }
        ppnRounded: { $ref: '#/components/schemas/Null' }
        total: { $ref: '#/components/schemas/Null' }
        manualOverride: { $ref: '#/components/schemas/TaxSnapshotManualOverrideIDR' }
  unevaluatedProperties: false

TaxSnapshotCustomRecordingNonIDR:
  allOf:
    - $ref: '#/components/schemas/TaxSnapshotAuditBase'
    - type: object
      required: [ruleId, ruleVersion, ruleCode, ruleStatus, calculationMode,
        effectiveDateMatched, verifiedAt, statutoryRateNumerator,
        statutoryRateDenominator, dppFactorNumerator, dppFactorDenominator,
        fixedAmount, roundDppBeforeTax, roundingStage, roundingMode,
        roundingUnitMinor, calculationScope, sources,
        considerationBeforeDiscount, discount, taxableBase,
        dppExactNumerator, dppExactDenominator, dppRounded,
        ppnExactNumerator, ppnExactDenominator, ppnRounded, total,
        manualOverride]
      properties:
        ruleId: { $ref: '#/components/schemas/Null' }
        ruleVersion: { $ref: '#/components/schemas/Null' }
        ruleCode: { $ref: '#/components/schemas/Null' }
        ruleStatus: { const: CUSTOM_UNVERIFIED }
        calculationMode: { $ref: '#/components/schemas/Null' }
        effectiveDateMatched: { $ref: '#/components/schemas/Null' }
        verifiedAt: { $ref: '#/components/schemas/Null' }
        statutoryRateNumerator: { $ref: '#/components/schemas/Null' }
        statutoryRateDenominator: { $ref: '#/components/schemas/Null' }
        dppFactorNumerator: { $ref: '#/components/schemas/Null' }
        dppFactorDenominator: { $ref: '#/components/schemas/Null' }
        fixedAmount: { $ref: '#/components/schemas/Null' }
        roundDppBeforeTax: { $ref: '#/components/schemas/Null' }
        roundingStage: { $ref: '#/components/schemas/Null' }
        roundingMode: { $ref: '#/components/schemas/Null' }
        roundingUnitMinor: { $ref: '#/components/schemas/Null' }
        calculationScope: { $ref: '#/components/schemas/Null' }
        sources: { $ref: '#/components/schemas/Null' }
        considerationBeforeDiscount: { $ref: '#/components/schemas/Null' }
        discount: { $ref: '#/components/schemas/Null' }
        taxableBase: { $ref: '#/components/schemas/Null' }
        dppExactNumerator: { $ref: '#/components/schemas/Null' }
        dppExactDenominator: { $ref: '#/components/schemas/Null' }
        dppRounded: { $ref: '#/components/schemas/Null' }
        ppnExactNumerator: { $ref: '#/components/schemas/Null' }
        ppnExactDenominator: { $ref: '#/components/schemas/Null' }
        ppnRounded: { $ref: '#/components/schemas/Null' }
        total: { $ref: '#/components/schemas/Null' }
        manualOverride: { $ref: '#/components/schemas/TaxSnapshotManualOverrideNonIDR' }
  unevaluatedProperties: false

TaxSnapshotManualOverrideIDR:
  type: object
  additionalProperties: false
  required: [label, amount, taxAmountCurrency, documentCurrency, reason,
    source, lineIds, actorId, at, customUnverified, exchangeRateEvidence]
  properties:
    label: { type: string, minLength: 1 }
    amount: { $ref: '#/components/schemas/MoneyOutput' }
    taxAmountCurrency: { const: IDR }
    documentCurrency: { const: IDR }
    reason: { type: string, minLength: 1 }
    source: { type: string, minLength: 1 }
    lineIds: { type: array, minItems: 1, items: { type: string, minLength: 1 } }
    actorId: { type: string, minLength: 1 }
    at: { type: string, format: date-time }
    customUnverified: { const: true }
    exchangeRateEvidence: { $ref: '#/components/schemas/Null' }

TaxSnapshotManualOverrideNonIDR:
  type: object
  additionalProperties: false
  required: [label, amount, taxAmountCurrency, documentCurrency, reason,
    source, lineIds, actorId, at, customUnverified, exchangeRateEvidence]
  properties:
    label: { type: string, minLength: 1 }
    amount: { $ref: '#/components/schemas/MoneyOutput' }
    taxAmountCurrency: { const: IDR }
    documentCurrency: { $ref: '#/components/schemas/NonIDRCurrencyCode' }
    reason: { type: string, minLength: 1 }
    source: { type: string, minLength: 1 }
    lineIds: { type: array, minItems: 1, items: { type: string, minLength: 1 } }
    actorId: { type: string, minLength: 1 }
    at: { type: string, format: date-time }
    customUnverified: { const: true }
    exchangeRateEvidence: { $ref: '#/components/schemas/ExchangeRateEvidence' }
```

`TaxSnapshotCustomRecordingIDR` requires `exchangeRateEvidence: null`. It rejects an omitted or non-null field. `TaxSnapshotCustomRecordingNonIDR` requires a non-null `ExchangeRateEvidence`. It rejects a null or omitted field.

For a recording, `TaxSnapshotCustomRecording*.manualOverride.documentCurrency` is the only immutable snapshot document-currency location. The server copies `TaxApplicationCustomRecording.manualOverride.documentCurrency` byte-for-byte to it.

The issue endpoint compares that value with the server-owned document currency before it writes a snapshot. It rejects a difference with `422 TAX_CURRENCY_MISMATCH`. A recording snapshot does not carry a second top-level document-currency field. It also does not contain an exchange rate, a selected exchange-rate source, or an inferred conversion.

## 8. Endpoint behavior and required negative vectors

Schema fixtures validate every `TaxRule`, `TaxCalculationResult`, `TaxApplicationInput`, and `TaxSnapshot` leaf. The affected issue endpoints validate the request, write the snapshot atomically, and return the issued document.

`sendNativeProjectQuotation` and `issueNativeProjectFinanceInvoice` are the only launch issue operations that accept `taxApplication`. `recordNativeProjectQuotationAcceptance` does not accept it.

The endpoints reject a failed mode shape with `422 TAX_RULE_MODE_CONFLICT`. They reject a mismatched snapshot currency with `422 TAX_CURRENCY_MISMATCH`. They reject invalid evidence presence with `422 TAX_RECORDING_EVIDENCE_INVALID`. They reject a missing recording acknowledgment with `422 TAX_ACKNOWLEDGMENT_MISSING`. A rejection writes neither an issued document nor a tax snapshot.

The implementation work must add both a schema vector and an endpoint vector for each row.

| ID | Rejected payload or server output | Required result |
|---|---|---|
| N1 | `FIXED_AMOUNT` result with non-null `dppRounded` | Schema and endpoint reject it. |
| N2 | `FIXED_AMOUNT` result with non-null `ppnRounded`, any rational numerator or denominator, or `roundingStage` | Schema and endpoint reject it. |
| N3 | Fixed `TaxRule` with a non-null rational constant, `roundDppBeforeTax: true`, or `roundingStage: DPP_THEN_PPN` | Schema and endpoint reject it. |
| N4 | Rational rule with a missing rational constant, `roundDppBeforeTax: null`, or a non-null fixed amount | Schema and endpoint reject it. |
| N5 | Verified rational snapshot with `effectiveDateMatched: null`, a missing approved constant, non-IDR currency, or a manual override | Schema and issue endpoint reject it. |
| N6 | Custom rational snapshot with non-null `verifiedAt` or non-null `effectiveDateMatched` | Schema and issue endpoint reject it. |
| N7 | Custom fixed snapshot with a non-null rational field, DPP field, PPN field, `roundDppBeforeTax`, or `roundingStage` | Schema and issue endpoint reject it. |
| N8 | Recording snapshot with a missing `manualOverride`, missing amount, null amount, non-null rule ID, non-null calculation mode, or any non-null calculation field | Schema and issue endpoint reject it. |
| N9 | Recording request where its server-owned document currency differs from `manualOverride.documentCurrency`, or a recording snapshot with a second top-level `documentCurrency` | Schema and endpoint reject it with `TAX_CURRENCY_MISMATCH`; the snapshot schema rejects the extra field. |
| N10 | Non-IDR recording with omitted or null `exchangeRateEvidence` | Schema and issue endpoint reject it. |
| N11 | IDR recording with omitted or non-null `exchangeRateEvidence` | Schema and issue endpoint reject it. |
| N12 | Recording snapshot with `acceptedConfirmationText` different from `recordingAcknowledgment.acceptedText` | Endpoint rejects it before persistence. |
| N13 | Any object that matches more than one `oneOf` branch or mixes recording and calculation fields | Schema and endpoint reject it. |
| N14 | `CUSTOM_UNVERIFIED` rule or calculation snapshot that reuses `PPN_STANDARD_2025` | Schema and endpoint reject it. |

The endpoint tests must assert snapshot absence after every rejected request. Serialization tests must prove that no invalid server-created `TaxSnapshot` can be emitted.

## 9. Review and implementation gate

The Backend Engineer must insert the founder-approved representation clause into section 2. The Backend Engineer then creates a fresh, self-contained Founding Engineer review issue. That issue copies this exact final body and requests one verdict: `concur`, `concur with conditions`, or `revise`.

`revise` blocks the reviewed revision. A pending or accepted CEO confirmation for that revision does not authorize implementation. The Backend Engineer must submit a new revision and a new review issue after a `revise` verdict.

No OpenAPI, server, schema, calculation, web, Swift, or test implementation may start until the fresh review records `concur` or actionable `concur with conditions`. CEO confirmation follows that verdict for the same final revision.
