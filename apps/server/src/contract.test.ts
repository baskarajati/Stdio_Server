/**
 * Contract tests for the SOL-25 revision-24 tax surface.
 *
 * These tests pin the three binding conditions of the CEO ruling (SOL-71
 * comment 8a45801d) and the normative requirements of revision 24 so a future
 * change cannot silently regress them. They read the working contract
 * `contracts/openapi/native-v1.yaml` and assert structure, not implementation.
 *
 * Conditions pinned here:
 * 1. `409 ENTITY_VERSION_CONFLICT` and `409 IDEMPOTENCY_KEY_REUSED` are
 *    declared responses and the new tax write paths reference them.
 * 2. `MoneyInput` is the strict `MoneyInputString` / `MoneyInputNumber` pair
 *    and the shared `NativeBuild` / `RequestId` components stay optional
 *    (vector N62).
 * 3. Required native headers on the new write paths (N61), the preview header
 *    rules (N64), ETag guarantees (N71), and the legacy request-field removal
 *    (N15, N16).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const CONTRACT_PATH = resolve(import.meta.dirname, '../../../contracts/openapi/native-v1.yaml');

function loadContract(): any {
  return parse(readFileSync(CONTRACT_PATH, 'utf8'));
}

function parameterRefs(operation: any): Set<string> {
  const refs = new Set<string>();
  for (const parameter of operation.parameters ?? []) {
    if (parameter.$ref) {
      refs.add(parameter.$ref.split('/').pop() ?? '');
    }
  }
  return refs;
}

const NEW_WRITE_PATHS = [
  '/tax-rules/custom',
  '/tax-rules/custom/{ruleId}/versions',
  '/purchase-orders/{id}/supplier-tax-recordings',
];

const ISSUE_PATHS = [
  '/projects/{id}/quotations/{quotationId}/send',
  '/projects/{id}/finance/invoices/{invoiceId}/issue',
  '/projects/{id}/finance/milestones/{milestoneId}/invoice',
];

describe('SOL-25 revision-24 contract conditions', () => {
  const doc = loadContract();
  const schemas = doc.components.schemas;
  const parameters = doc.components.parameters;
  const paths = doc.paths;

  it('declares both 409 problem codes (condition 1)', () => {
    expect(schemas.EntityVersionConflictProblem.properties.code.enum).toEqual([
      'ENTITY_VERSION_CONFLICT',
    ]);
    expect(schemas.IdempotencyKeyReusedProblem.properties.code.enum).toEqual([
      'IDEMPOTENCY_KEY_REUSED',
    ]);
    expect(doc.components.responses.MutationConflict).toBeDefined();
  });

  it('references the 409 MutationConflict response on every new tax write path', () => {
    for (const path of NEW_WRITE_PATHS) {
      expect(paths[path].post.responses['409'].$ref).toBe(
        '#/components/responses/MutationConflict',
      );
    }
  });

  it('replaces MoneyInput with the strict string/number pair (condition 2)', () => {
    const moneyInput = schemas.MoneyInput;
    expect(moneyInput.oneOf.map((branch: any) => branch.$ref)).toEqual([
      '#/components/schemas/MoneyInputString',
      '#/components/schemas/MoneyInputNumber',
    ]);
    expect(schemas.MoneyInputString.type).toBe('string');
    expect(schemas.MoneyInputString.pattern).toBe(
      '^[+-]?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$',
    );
    expect(schemas.MoneyInputNumber.exclusiveMinimum).toBe(-9007199254740992);
    expect(schemas.MoneyInputNumber.exclusiveMaximum).toBe(9007199254740992);
  });

  it('keeps the shared NativeBuild and RequestId optional (vector N62)', () => {
    expect(parameters.NativeBuild.required).toBe(false);
    expect(parameters.RequestId.required).toBe(false);
  });

  it('requires the dedicated native headers on every new write path (vector N61)', () => {
    for (const path of NEW_WRITE_PATHS) {
      const refs = parameterRefs(paths[path].post);
      expect(refs).toContain('NativeBuildRequired');
      expect(refs).toContain('RequestIdRequired');
      expect(refs).toContain('IdempotencyKey');
      expect(refs).toContain('IfMatch');
    }
  });

  it('requires the catalog tag on preview and keeps it optional-conditional on issue', () => {
    const preview = paths['/tax-calculations'].post;
    expect(parameterRefs(preview)).toContain('TaxCatalogTagRequired');
    expect(parameterRefs(preview)).not.toContain('IdempotencyKey');
    expect(parameterRefs(preview)).not.toContain('IfMatch');
    expect(preview.responses['200'].headers).toBeUndefined();
    for (const path of ISSUE_PATHS) {
      expect(parameterRefs(paths[path].post)).toContain('TaxCatalogTagOptional');
    }
  });

  it('requires the ETag header on the issue operations and discovery (vector N71)', () => {
    for (const path of ISSUE_PATHS) {
      for (const code of ['200', '201']) {
        const headers = paths[path].post.responses[code].headers;
        expect(headers.ETag.required).toBe(true);
        expect(headers.ETag.schema.minLength).toBeGreaterThan(0);
      }
    }
    expect(paths['/tax-rules/resolve'].get.responses['200'].headers.ETag.required).toBe(true);
  });

  it('returns the issue-only envelopes with taxSnapshot on the three issue operations', () => {
    for (const path of ISSUE_PATHS) {
      for (const code of ['200', '201']) {
        const schema = paths[path].post.responses[code].content['application/json'].schema.$ref;
        expect(schema).toBeOneOf([
          '#/components/schemas/ProjectQuotationIssueResponse',
          '#/components/schemas/ProjectFinanceInvoiceIssueResponse',
        ]);
      }
    }
  });

  it('removes the legacy taxRate and taxEvidence request fields (vectors N15, N16)', () => {
    expect(schemas.ProjectFinanceMilestoneInvoiceRequest.properties.taxRate).toBeUndefined();
    expect(schemas.ProjectFinanceMilestoneInvoiceRequest.required).not.toContain('taxRate');
    expect(schemas.ProjectFinanceInvoiceIssueRequest.properties.taxEvidence).toBeUndefined();
  });

  it('accepts taxApplication on the send, milestone, and issue request surfaces', () => {
    for (const name of [
      'ProjectQuotationSendRequest',
      'ProjectFinanceMilestoneInvoiceRequest',
      'ProjectFinanceInvoiceIssueRequest',
    ]) {
      expect(schemas[name].properties.taxApplication).toBeDefined();
    }
    expect(schemas.ProjectQuotationIssueResponse.properties.data.required).toContain('taxSnapshot');
    expect(schemas.ProjectFinanceInvoiceIssueResponse.properties.data.required).toContain(
      'taxSnapshot',
    );
  });
});

describe('SOL-167 register-created invoice engagement attachment', () => {
  it('declares engagementId on InvoiceCreateRequest (optional string)', () => {
    const create = loadContract().components.schemas.InvoiceCreateRequest;
    expect(create.properties.engagementId.type).toBe('string');
    expect(create.required).not.toContain('engagementId');
  });

  it('declares engagementId on InvoiceUpdateRequest (string or null)', () => {
    const update = loadContract().components.schemas.InvoiceUpdateRequest;
    expect(update.properties.engagementId.type).toEqual(['string', 'null']);
  });
});
