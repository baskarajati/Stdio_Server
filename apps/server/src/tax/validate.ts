/**
 * Request validation for the non-application parts of the tax surface.
 *
 * The `taxApplication` value is parsed by `./application` (which owns the
 * closed three-branch discrimination and the exact rejection codes). This
 * module owns the other request bodies (custom rule drafts, supplier
 * recordings, milestone invoices), the strict date rule, and the raw-JSON
 * structural layer. Money values inside these bodies go through
 * `parseMoneyMinor` (strict, exact arithmetic, the three rejection
 * categories).
 */

import { z } from 'zod';

import { TaxWriteRejection } from './codes';

/** A date `YYYY-MM-DD` that is also a real calendar date. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a `format: date` value. Returns the canonical date text. */
export function parseContractDate(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TaxWriteRejection({
      status: 422,
      code: 'INVALID_DATE',
      title: 'Invalid date',
      detail: `${field} must be an ISO date string (YYYY-MM-DD).`,
    });
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new TaxWriteRejection({
      status: 422,
      code: 'INVALID_DATE',
      title: 'Invalid date',
      detail: `${field} must be an ISO date string (YYYY-MM-DD), got "${value}".`,
    });
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new TaxWriteRejection({
      status: 422,
      code: 'INVALID_DATE',
      title: 'Invalid date',
      detail: `${field} "${value}" is not a real calendar date.`,
    });
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new TaxWriteRejection({
      status: 422,
      code: 'INVALID_DATE',
      title: 'Invalid date',
      detail: `${field} "${value}" is not a real calendar date.`,
    });
  }
  return value;
}

/** The TaxRuleSource shape (section 5). */
const taxRuleSourceSchema = z
  .object({
    authority: z.string().min(1),
    title: z.string().min(1),
    url: z.string().url(),
    publishedAt: z.union([z.string(), z.null()]),
    retrievedAt: z.string(),
  })
  .strict();

/** A non-IDR ISO 4217 code, or null for the IDR recording branch. */
const nonIdrCurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((code) => code !== 'IDR', { message: 'must not be IDR' });

const exchangeRateEvidenceSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

/** The CustomTaxRuleDraft union (rational or fixed). */
export const customTaxRuleDraftSchema = z.discriminatedUnion('calculationMode', [
  z
    .object({
      label: z.string().min(1),
      code: z.string().min(1),
      effectiveFrom: z.string(),
      effectiveTo: z.union([z.string(), z.null()]),
      sources: z.array(taxRuleSourceSchema).min(1),
      disclaimerText: z.string().min(1),
      unverifiedAcknowledgment: z
        .object({
          accepted: z.literal(true),
          acceptedText: z.string().min(1),
        })
        .strict(),
      calculationMode: z.literal('RATIONAL_RATE'),
      statutoryRateNumerator: z.string().regex(/^[1-9][0-9]*$/),
      statutoryRateDenominator: z.string().regex(/^[1-9][0-9]*$/),
      dppFactorNumerator: z.string().regex(/^[1-9][0-9]*$/),
      dppFactorDenominator: z.string().regex(/^[1-9][0-9]*$/),
    })
    .strict(),
  z
    .object({
      label: z.string().min(1),
      code: z.string().min(1),
      effectiveFrom: z.string(),
      effectiveTo: z.union([z.string(), z.null()]),
      sources: z.array(taxRuleSourceSchema).min(1),
      disclaimerText: z.string().min(1),
      unverifiedAcknowledgment: z
        .object({
          accepted: z.literal(true),
          acceptedText: z.string().min(1),
        })
        .strict(),
      calculationMode: z.literal('FIXED_AMOUNT'),
      fixedAmount: z.union([z.string(), z.number()]),
    })
    .strict(),
]);

/** The SupplierTaxRecordingRequest union (IDR or non-IDR document). */
export const supplierTaxRecordingRequestSchema = z.union([
  z
    .object({
      supplierDocumentReference: z.string().min(1),
      label: z.string().min(1),
      documentCurrency: z.literal('IDR'),
      dppAmount: z.union([z.string(), z.number()]),
      taxAmount: z.union([z.string(), z.number()]),
      exchangeRateEvidence: z.null(),
      source: taxRuleSourceSchema,
      acknowledgment: z
        .object({
          accepted: z.literal(true),
          acceptedText: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      supplierDocumentReference: z.string().min(1),
      label: z.string().min(1),
      documentCurrency: nonIdrCurrencySchema,
      dppAmount: z.union([z.string(), z.number()]),
      taxAmount: z.union([z.string(), z.number()]),
      exchangeRateEvidence: exchangeRateEvidenceSchema,
      source: taxRuleSourceSchema,
      acknowledgment: z
        .object({
          accepted: z.literal(true),
          acceptedText: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

/** The issue-operation bodies: taxApplication optional and nullable. */
export const issueOperationBodySchema = z
  .object({
    taxApplication: z.unknown().nullable().optional(),
  })
  .strict();

/** The preview body: explicit amounts plus one taxApplication branch. */
export const previewBodySchema = z
  .object({
    documentIssueDate: z.string(),
    documentCurrency: z.literal('IDR'),
    considerationBeforeDiscount: z.union([z.string(), z.number()]),
    discount: z.union([z.string(), z.number()]),
    taxApplication: z.unknown(),
  })
  .strict();

/** The milestone-invoice body: dueDate required, taxApplication nullable. */
export const milestoneInvoiceBodySchema = z
  .object({
    dueDate: z.string().min(1),
    progressCertificateId: z.union([z.string().uuid(), z.null()]).optional(),
    taxApplication: z.unknown().nullable().optional(),
  })
  .strict();

/**
 * Parses a raw JSON body. A syntax or structural failure throws a `400
 * INVALID_BODY` rejection (schema layer); the caller then runs the semantic
 * checks (money categories, dates) with their exact 422 codes.
 */
export function parseBody<T>(schema: z.ZodType<T>, rawBody: string): T {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new TaxWriteRejection({
      status: 400,
      code: 'INVALID_BODY',
      title: 'Invalid JSON body',
      detail: 'The request body is not valid JSON.',
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new TaxWriteRejection({
      status: 400,
      code: 'INVALID_BODY',
      title: 'Invalid request body',
      detail: `Body validation failed: ${first ? `${first.path.join('.')} ${first.message}` : 'unknown issue'}.`,
    });
  }
  return parsed.data;
}
