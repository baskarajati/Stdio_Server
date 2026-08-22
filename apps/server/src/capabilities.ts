/**
 * Capability projection.
 *
 * Capabilities come from the server: the client never adds a permission
 * matrix. The `Capability` contract shape is `{enabled, reason}`. When disabled
 * the UI shows `reason`, never a silent grey control (D-042).
 *
 * This file projects the contract capabilities from a staff user's role and
 * the finite SOL-20 tax scope. Money write decisions live here, not in the
 * client.
 */

import type { StudioRole } from './context/db';

export type Capability = { enabled: boolean; reason: string };

/** The known capability keys, typed so call sites need no index guards. */
export type CapabilityKey =
  | 'canReadFinance'
  | 'canReadContracts'
  | 'canWriteQuotation'
  | 'canWriteVariationOrder'
  | 'canWriteInvoiceDraft'
  | 'canIssueInvoice'
  | 'canRecordInvoicePayment'
  | 'canUpdateInvoiceCollection'
  | 'canWriteClient'
  | 'canWriteVendor'
  | 'canWriteSpecItem'
  | 'canWriteInvoice';

export type CapabilitySet = Record<CapabilityKey, Capability>;

/** The tax mode is one of the launch modes. PPN_STANDARD_2025 stays behind SOL-25. */
export type TaxMode = 'NONE' | 'CUSTOM_UNVERIFIED' | 'PPN_STANDARD_2025';

const DISABLED_PAYMENT =
  'Payment recording is deferred. SOL-20 defers all PPh withholding and retensi splitting; ' +
  'A-010 leaves PPh timing on retained cash to an accountant. The amount/date/method payload ' +
  'cannot represent cash, PPh, and retensi separately.';

/**
 * Projects the native contract capabilities for one staff user.
 *
 * `canReadFinance` follows the money lens (D-007): OWNER and FINANCE see the
 * financial figures; other roles get a masked lens (the server sets money
 * fields to null). The SOL-28 review gate closed on 2026-08-22 (revision 7
 * concurred, CEO confirmation `b6701b4e`), so the quotation and
 * variation-order writes are enabled for the studio OWNER. Invoice draft and
 * issue stay gated behind SOL-25's approved tax snapshot contract. Payment
 * recording stays permanently disabled (SOL-20, A-010). Reads and
 * collection-control metadata are allowed.
 */
export function projectCapabilities(role: StudioRole): CapabilitySet {
  const canReadFinance = role === 'OWNER' || role === 'FINANCE';

  return {
    // The finance lens. When disabled the server masks every money field.
    canReadFinance: {
      enabled: canReadFinance,
      reason: canReadFinance ? '' : 'This role cannot read finance figures.',
    },
    canReadContracts: { enabled: true, reason: '' },

    // Writes that shipped with the SOL-28 review gate. The owner approves
    // money and scope changes; other roles read only.
    canWriteQuotation: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can write quotations.',
    },
    canWriteVariationOrder: {
      enabled: role === 'OWNER',
      reason:
        role === 'OWNER' ? '' : 'Only the studio owner can approve and issue a variation order.',
    },

    // Invoice draft/issue carry the SOL-25 tax snapshot contract. The
    // SOL-25 server slice has merged (Founding Engineer concurrence,
    // SOL-107): the snapshot immutability and the 426 build gate are live.
    // Per SOL-107 condition 1, draft and issue are enabled for the studio
    // OWNER; payment recording stays permanently disabled (SOL-20, A-010).
    canWriteInvoiceDraft: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can write an invoice draft.',
    },
    canIssueInvoice: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can issue an invoice.',
    },

    // Payment recording is deferred by SOL-20 and A-010, whatever the role.
    canRecordInvoicePayment: { enabled: false, reason: DISABLED_PAYMENT },

    // Collection control is control metadata, not a money write (SOL-6).
    canUpdateInvoiceCollection: { enabled: true, reason: '' },

    // SOL-19 revision 6 register writes. Writes are ownership decisions
    // (D-007 Q-C: writes are membership-governed); for launch the studio
    // owner is the writer, matching canWriteQuotation. Other roles read.
    canWriteClient: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can create and update clients.',
    },
    canWriteVendor: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can create and update vendors.',
    },
    canWriteSpecItem: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can create and update spec items.',
    },
    canWriteInvoice: {
      enabled: role === 'OWNER',
      reason: role === 'OWNER' ? '' : 'Only the studio owner can create and update invoices.',
    },
  };
}

/** The SOL-19 timesheet capabilities (contract `TimesheetCapabilities`). */
export function timesheetCapabilitiesFor(role: StudioRole) {
  const writer = role === 'OWNER' || role === 'PM';
  return {
    create: {
      enabled: writer,
      reason: writer ? '' : 'Only the owner and project managers can log timesheet entries.',
    },
    edit: {
      enabled: writer,
      reason: writer ? '' : 'Only the owner and project managers can edit timesheet entries.',
    },
    read: { enabled: true, reason: '' },
    void: {
      enabled: writer,
      reason: writer ? '' : 'Only the owner and project managers can void timesheet entries.',
    },
  };
}
