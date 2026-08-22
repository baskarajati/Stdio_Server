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
 * The controlled evidence register. Every URL is a verified jdih
 * `full_text_pdf` path: UU 7/2021 and PMK 131/2024 were verified against the
 * official jdih catalogue under SOL-106 condition C1 (artifact SHA-256 in
 * `docs/tax/evidence-register-verification.md`), and re-confirmed on
 * 2026-08-22 for the SOL-116 port. PER-11/PJ/2025 was verified the same way
 * on 2026-08-22 (SOL-116). Listing pages and short `/dok/...` paths are
 * rejected by `assertPresetRegisterValid`.
 */
export const PPN_2025_EVIDENCE: readonly VerifiedTaxEvidence[] = [
  {
    evidenceId: 'UU-7-2021-HPP',
    authority: 'DJP_RI',
    documentIdentifier: 'UU 7/2021',
    title: 'Undang-Undang Nomor 7 Tahun 2021 tentang Harmonisasi Peraturan Perpajakan',
    url: 'https://jdih.kemenkeu.go.id/api/download/A9FAAB97-ACA7-4F87-9FDC-FAA8123D1454/7TAHUN2021UU.pdf',
    publishedAt: '2021-10-29',
    retrievedAt: '2026-08-22T21:10:00.000Z',
  },
  {
    evidenceId: 'PMK-131-2024-ART3',
    authority: 'DJP_RI',
    documentIdentifier: 'PMK-131/PMK.010/2024',
    title:
      'Peraturan Menteri Keuangan Nomor 131 Tahun 2024 tentang Perlakuan Pajak Pertambahan Nilai atas Impor Barang Kena Pajak, Penyerahan Barang Kena Pajak, Penyerahan Jasa Kena Pajak, Pemanfaatan Barang Kena Pajak Tidak Berwujud dari Luar Daerah Pabean di Dalam Daerah Pabean, dan Pemanfaatan Jasa Kena Pajak dari Luar Daerah Pabean di Dalam Daerah Pabean',
    url: 'https://jdih.kemenkeu.go.id/api/download/F128868E-3CF6-4596-8407-C34EECA0E7BE/2024pmkeuangan131.pdf',
    publishedAt: '2024-12-31',
    retrievedAt: '2026-08-22T21:10:00.000Z',
  },
  {
    evidenceId: 'PMK-131-2024-JDIH',
    authority: 'KEMENKEU_RI',
    documentIdentifier: 'PMK-131-TAHUN-2024',
    title:
      'Peraturan Menteri Keuangan Nomor 131 Tahun 2024 tentang Perlakuan Pajak Pertambahan Nilai atas Impor Barang Kena Pajak, Penyerahan Barang Kena Pajak, Penyerahan Jasa Kena Pajak, Pemanfaatan Barang Kena Pajak Tidak Berwujud dari Luar Daerah Pabean di Dalam Daerah Pabean, dan Pemanfaatan Jasa Kena Pajak dari Luar Daerah Pabean di Dalam Daerah Pabean',
    url: 'https://jdih.kemenkeu.go.id/api/download/F128868E-3CF6-4596-8407-C34EECA0E7BE/2024pmkeuangan131.pdf',
    publishedAt: '2024-12-31',
    retrievedAt: '2026-08-22T21:10:00.000Z',
  },
  {
    evidenceId: 'PER-11-PJ-2025-ART129',
    authority: 'DJP_RI',
    documentIdentifier: 'PER-11/PJ/2025',
    title:
      'PER-11/PJ/2025 — Ketentuan Pelaporan Pajak Penghasilan, Pajak Pertambahan Nilai, Pajak Penjualan atas Barang Mewah, dan Bea Meterai dalam Rangka Pelaksanaan Sistem Inti Administrasi Perpajakan',
    url: 'https://jdih.kemenkeu.go.id/api/download/A94EDEE5-E585-4EEB-B9E7-A76F616C92FB/PER-11_PJ_2025.pdf',
    publishedAt: '2025-05-22',
    retrievedAt: '2026-08-22T22:05:00.000Z',
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

/**
 * Fails closed on a corrupt or unverified register (SOL-104 condition C1,
 * ported from the old stack). Every evidence URL must be a government
 * document on `pajak.go.id` or `jdih.kemenkeu.go.id`; evidence ids and
 * exclusion codes must be unique and non-empty; the register must hold only
 * `PPN_STANDARD_2025` from 2025-01-01 onward. Arguments default to the
 * shipped constants so the guard is directly testable on bad input.
 */
export function assertPresetRegisterValid(
  evidence: readonly VerifiedTaxEvidence[] = PPN_2025_EVIDENCE,
  exclusions: readonly VerifiedTaxExclusion[] = PPN_2025_EXCLUSIONS,
  register: readonly VerifiedPpnRule[] = PPN_2025_REGISTER,
): void {
  const evidenceIds = new Set<string>();
  for (const entry of evidence) {
    if (!entry.evidenceId || evidenceIds.has(entry.evidenceId)) {
      throw new Error('TAX_RULE_REGISTER_INVALID: duplicate or empty evidenceId');
    }
    if (entry.authority !== 'KEMENKEU_RI' && entry.authority !== 'DJP_RI') {
      throw new Error('TAX_RULE_REGISTER_INVALID: unknown authority');
    }
    if (!/^https:\/\/(?:www\.)?(?:pajak\.go\.id|jdih\.kemenkeu\.go\.id)\//.test(entry.url)) {
      throw new Error(`TAX_RULE_REGISTER_INVALID: non-government URL ${entry.url}`);
    }
    evidenceIds.add(entry.evidenceId);
  }
  const exclusionCodes = new Set<string>();
  for (const exclusion of exclusions) {
    if (!exclusion.code || exclusionCodes.has(exclusion.code)) {
      throw new Error('TAX_RULE_REGISTER_INVALID: duplicate or empty exclusion code');
    }
    exclusionCodes.add(exclusion.code);
  }
  for (const version of register) {
    if (version.code !== 'PPN_STANDARD_2025') {
      throw new Error('TAX_RULE_REGISTER_INVALID: bad code');
    }
    if (version.effectiveFrom < '2025-01-01') {
      throw new Error('TAX_RULE_REGISTER_INVALID: bad start');
    }
  }
}
