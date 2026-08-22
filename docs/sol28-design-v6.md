# SOL-28 design revision 6 — forged-prototype-safe raw decimal writer

Date: 2026-08-22  
Scope: proposal only; no consequential route, OpenAPI, or native implementation is authorised.

## 1. Revision lineage and decision state

Revision 6 supersedes `sol28-proposal` revision `71970f42` (design revision 5).
The Founding Engineer rejected revision 5 because `serializeJson` accepts an
object created with `Object.create(RawDecimal.prototype)`. Such an object passes
`instanceof RawDecimal` but has no entry in the private `RAW_TOKENS` registry,
so the current writer emits `undefined` and produces invalid JSON.

Revision 6 incorporates revision 5 except where this document replaces its
structural-safety and verification claims. In particular, it preserves:

- the complete field-level wire map, including
  `ProjectFinanceInvoice.payments[].amount`;
- the explicit label-only classifications;
- native exact-decimal migration steps M1-M9 and public propagation P1-P5;
- the exact server-byte/native-decoder cases `0.01`, `-0.01`, and
  `999999999999999999.99`;
- lossless raw decimal response writing without JavaScript `Number`;
- engagement-scoped routes;
- D-033 variation-order transaction-price behaviour;
- capability, idempotency, and entity-version guards;
- invoice-write denial until SOL-25 is approved and complete; and
- permanent payment-write denial.

The revision-4 and revision-5 review verdicts are `revise`. Old confirmations
and the accepted authorization probe do not authorize implementation.

## 2. Reproduced defect

Current revision-5-shaped code:

```ts
if (value instanceof RawDecimal) {
  return RAW_TOKENS.get(value) as string;
}
```

Counterexample:

```ts
const forged = Object.create(RawDecimal.prototype);
serializeJson({ amount: forged });
```

`forged instanceof RawDecimal` is `true`, but `RAW_TOKENS.has(forged)` is
`false`. The current result is `{"amount":undefined}`, which is not JSON.

## 3. Exact revision-6 writer proposal

Replace the raw-token branch with this closed registry-membership check:

```ts
if (value instanceof RawDecimal) {
  if (!RAW_TOKENS.has(value)) {
    throw new TypeError('Invalid RawDecimal: token was not created by the validating constructor.');
  }
  return RAW_TOKENS.get(value) as string;
}
```

The ordering is normative:

1. Identify a `RawDecimal` instance.
2. Prove that the module-private registry contains that exact object.
3. Throw before response bytes are produced when the proof fails.
4. Read and emit the token only after membership succeeds.

No public property, getter, `serialize()` method, prototype method, or caller
supplied fragment participates in the decision. A valid registry token still
comes only from the constructor, after `moneyFromDecimal` validates it with
exact integer-minor-unit arithmetic.

## 4. Required server test

Add this case to `apps/server/src/money.test.ts`:

```ts
it('rejects a RawDecimal prototype forgery before producing response bytes', () => {
  const forged = Object.create(RawDecimal.prototype) as RawDecimal;

  expect(forged).toBeInstanceOf(RawDecimal);
  expect(() => serializeJson({ amount: forged })).toThrow(TypeError);
  expect(() => serializeJson({ amount: forged })).toThrow(/Invalid RawDecimal/);
});
```

The assertion is deliberately on the serializer call. It proves the writer
does not return `{"amount":undefined}`, a partial body, or any other invalid or
attacker-controlled JSON. The existing subclass, prototype-patch, frozen
instance, invalid precision, out-of-range, exact-byte, and JSON-escaping tests
remain required.

## 5. Verification gates after concurrence

The revision-6 guard and test are not implemented by this proposal. Therefore,
the current 37-test baseline does not prove the new vector, and this proposal
does not claim that it does.

After a `concur` or `concur with conditions` verdict authorizes the narrow
change, the implementation owner must run and record:

```text
pnpm --filter @stdio/server test
pnpm --filter @stdio/server typecheck
pnpm --filter @stdio/core test
scripts/sol28-money-native-proof.sh
```

Required outcomes:

- the forged-prototype test throws `TypeError` before bytes are returned;
- all existing raw-fragment attack tests still pass;
- exact response tokens remain `0.01`, `-0.01`, and
  `999999999999999999.99`;
- Swift `Decimal` decodes all three exactly;
- current Swift `Double` still demonstrates why M1-M9/P1-P5 are required; and
- `contracts/openapi/native-v1.yaml` remains unchanged until the reviewed
  server-first contract sequence authorizes it.

## 6. Review question

Founding Engineer: record one explicit verdict for this exact revision:
`concur`, `concur with conditions`, or `revise`.

Implementation and hand-back to SOL-28 remain paused unless the verdict is
`concur` or `concur with conditions`.
