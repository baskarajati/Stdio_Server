/**
 * The approved `PPN_STANDARD_2025` verified rule, its controlled evidence
 * register, exclusions, and the confirmation texts. SOL-25 revision 24,
 * sections 5 and 9.5: the verified leaf is centrally owned, tenant-immutable,
 * and copied byte-for-byte into every verified snapshot. The register entries
 * are server configuration reviewed with the preset.
 */

/** A verified evidence register entry (section 9.5 `VerifiedTaxEvidence`). */
export type VerifiedTaxEvidence = {
  readonly evidenceId: string;
  readonly authority: 'KEMENKEU_RI' | 'DJP_RI';
  readonly documentIdentifier: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string; // date
  readonly retrievedAt: string; // date-time
};

export type VerifiedTaxExclusion = {
  readonly code: string;
  readonly label: string;
};

/** The verified rational rule leaf (section 5 `TaxRuleVerifiedRational`). */
export type VerifiedPpnRule = {
  readonly id: string;
  readonly version: number;
  readonly ownerType: 'CENTRAL';
  readonly studioId: null;
  readonly status: 'VERIFIED';
  readonly code: 'PPN_STANDARD_2025';
  readonly jurisdiction: 'ID';
  readonly taxType: 'PPN';
  readonly currency: 'IDR';
  readonly calculationMode: 'RATIONAL_RATE';
  readonly effectiveFrom: string; // date
  readonly effectiveTo: string | null; // date
  readonly verifiedAt: string; // date
  readonly statutoryRateNumerator: '12';
  readonly statutoryRateDenominator: '100';
  readonly dppFactorNumerator: '11';
  readonly dppFactorDenominator: '12';
  readonly fixedAmount: null;
  readonly roundingMode: 'HALF_UP';
  readonly roundingUnitMinor: 100;
  readonly roundDppBeforeTax: true;
  readonly roundingStage: 'DPP_THEN_PPN';
  readonly calculationScope: 'DOCUMENT_TAX_BUCKET';
  readonly verifiedEvidence: readonly VerifiedTaxEvidence[];
  readonly exclusions: readonly VerifiedTaxExclusion[];
  readonly applicabilityConfirmationText: string;
  readonly disclaimerText: string;
  readonly entityVersion: string;
};

/**
 * The controlled evidence register. PMK 131/2024 was signed and promulgated
 * on 2024-12-31 and became effective 2025-01-01 (verified). The PER-11/PJ/2025
 * date is taken from the published record (2025-05-22) and is a review item
 * for the Founding Engineer PR review.
 */
export const PPN_2025_EVIDENCE: readonly VerifiedTaxEvidence[] = [
  {
    evidenceId: 'PMK-131-2024-ART3',
    authority: 'DJP_RI',
    documentIdentifier: 'PMK-131/PMK.010/2024',
    title:
      'PMK 131 Tahun 2024 — Perlakuan Pajak Pertambahan Nilai atas Impor Barang Kena Pajak, Penyerahan Barang Kena Pajak, Penyerahan Jasa Kena Pajak, Pemanfaatan Barang Kena Pajak Tidak Berwujud dari Luar Daerah Pabean di dalam Daerah Pabean, dan Pemanfaatan Jasa Kena Pajak dari Luar Daerah Pabean di dalam Daerah Pabean',
    url: 'https://www.pajak.go.id/index.php/id/peraturan/perlakuan-pajak-pertambahan-nilai-atas-impor-barang-kena-pajak-penyerahan-barang-kena',
    publishedAt: '2024-12-31',
    retrievedAt: '2026-08-21T00:00:00.000Z',
  },
  {
    evidenceId: 'PMK-131-2024-JDIH',
    authority: 'KEMENKEU_RI',
    documentIdentifier: 'PMK-131-TAHUN-2024',
    title: 'PMK 131 Tahun 2024 — Kemenkeu JDIH regulation record',
    url: 'https://jdih.kemenkeu.go.id/dok/pmk-131-tahun-2024',
    publishedAt: '2024-12-31',
    retrievedAt: '2026-08-21T00:00:00.000Z',
  },
  {
    evidenceId: 'PER-11-PJ-2025-ART129',
    authority: 'DJP_RI',
    documentIdentifier: 'PER-11/PJ/2025',
    title:
      'PER-11/PJ/2025 — Ketentuan Pelaporan Pajak Penghasilan, Pajak Pertambahan Nilai, Pajak Penjualan atas Barang Mewah, dan Bea Meterai dalam Rangka Pelaksanaan Sistem Inti Administrasi Perpajakan',
    url: 'https://pajak.go.id/id/peraturan/ketentuan-pelaporan-pajak-penghasilan-pajak-pertambahan-nilai-pajak-penjualan-atas-barang',
    publishedAt: '2025-05-22',
    retrievedAt: '2026-08-21T00:00:00.000Z',
  },
];

/** The approved exclusion register (copied into every verified snapshot). */
export const PPN_2025_EXCLUSIONS: readonly VerifiedTaxExclusion[] = [
  { code: 'TAX_INCLUSIVE_BACKSOLVING', label: 'Tax-inclusive price back-solving' },
  { code: 'PKP_ELIGIBILITY', label: 'PKP eligibility or turnover thresholds' },
  { code: 'EXEMPT_SUPPLY_CLASSIFICATION', label: 'Exempt or non-taxable supply classification' },
  { code: 'SPECIAL_DPP_REGIME', label: 'Special DPP or specific-amount regimes' },
  { code: 'LUXURY_GOODS_PPN_PPBM', label: 'Luxury goods PPN and PPnBM' },
  { code: 'PPh_WITHHOLDING', label: 'PPh withholding of any article' },
  { code: 'INPUT_TAX_CREDIT', label: 'Input-tax credit decisions' },
  {
    code: 'FAKTUR_PAJAK_CORETAX',
    label: 'Faktur Pajak or Coretax generation, serials, filing, or submission',
  },
  { code: 'FOREIGN_CURRENCY_TAX', label: 'Foreign-currency tax calculation' },
  { code: 'CORRECTIONS', label: 'Returns, refunds, corrections, penalties, and deadlines' },
];

export const PPN_2025_APPLICABILITY_CONFIRMATION_TEXT =
  'I confirm that this transaction takes place in Indonesia, falls within PMK 131/2024 Article 3, and is not subject to a separately regulated DPP or specific-amount regime. I confirm that our PKP status is recorded by us in Stdio. Stdio does not determine PKP status, taxability, exemptions, special regimes, filing duties, or eligibility.';

export const PPN_2025_DISCLAIMER_TEXT =
  'Stdio calculates amounts from the rule and choices you provide. Stdio does not determine PKP status, taxability, exemptions, special regimes, filing duties, or eligibility. Confirm these choices against your records or a qualified professional.';

/** The single centrally owned verified preset. */
export const PPN_STANDARD_2025: VerifiedPpnRule = {
  id: 'PPN_STANDARD_2025',
  version: 1,
  ownerType: 'CENTRAL',
  studioId: null,
  status: 'VERIFIED',
  code: 'PPN_STANDARD_2025',
  jurisdiction: 'ID',
  taxType: 'PPN',
  currency: 'IDR',
  calculationMode: 'RATIONAL_RATE',
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  verifiedAt: '2026-08-21',
  statutoryRateNumerator: '12',
  statutoryRateDenominator: '100',
  dppFactorNumerator: '11',
  dppFactorDenominator: '12',
  fixedAmount: null,
  roundingMode: 'HALF_UP',
  roundingUnitMinor: 100,
  roundDppBeforeTax: true,
  roundingStage: 'DPP_THEN_PPN',
  calculationScope: 'DOCUMENT_TAX_BUCKET',
  verifiedEvidence: PPN_2025_EVIDENCE,
  exclusions: PPN_2025_EXCLUSIONS,
  applicabilityConfirmationText: PPN_2025_APPLICABILITY_CONFIRMATION_TEXT,
  disclaimerText: PPN_2025_DISCLAIMER_TEXT,
  entityVersion: '1',
};

/** The central register: version 1 begins exactly 2025-01-01. */
export const PPN_2025_REGISTER: readonly VerifiedPpnRule[] = [PPN_STANDARD_2025];

/**
 * Resolves the verified rule whose half-open interval `[effectiveFrom,
 * effectiveTo)` contains `issueDate`. Null upper bound is open-ended. Zero
 * matches return null; multiple matches fail closed (register corruption).
 */
export function resolveVerifiedRule(
  issueDate: string,
  register: readonly VerifiedPpnRule[] = PPN_2025_REGISTER,
): VerifiedPpnRule | null {
  const matches = register.filter((rule) => {
    if (issueDate < rule.effectiveFrom) {
      return false;
    }
    return rule.effectiveTo === null || issueDate < rule.effectiveTo;
  });
  if (matches.length > 1) {
    throw new RangeError(
      'TAX_RULE_REGISTER_INVALID: more than one verified version matches the issue date.',
    );
  }
  return matches[0] ?? null;
}
