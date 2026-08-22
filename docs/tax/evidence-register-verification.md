# Evidence-register verification (SOL-104 condition C1)

Status: verified 2026-08-22 by the Backend Engineer (SOL-106); re-confirmed and
extended to PER-11/PJ/2025 on 2026-08-22 for the SOL-116 port into the
`Stdio_Server` monorepo.

## Method

Each `PPN_2025_EVIDENCE` entry in `packages/core/src/tax/ppn-2025.ts` is
checked against the official JDIH Kementerian Keuangan catalogue
(`jdih.kemenkeu.go.id`).

Steps per entry:

1. Locate the document in the jdih search API (`/api/search?q=<number>`).
2. Record the jdih `produk_hukum_id`, `full_text_pdf` path, title and
   `tanggal_penetapan`.
3. Download the PDF from the `full_text_pdf` path.
4. Compute SHA-256 of the downloaded artifact.
5. Extract the cover page and compare the printed number, title and date
   with the register entry.

The jdih site blocks TLS from the agent shell and from the CEO network.
The searches, downloads and hashes succeeded through a different egress
path (the harness browser fetch with WebCrypto SHA-256; cover-page OCR of
the rendered first page).

## Entry 1 — `UU-7-2021-HPP`

- jdih search result: `slug uu-7-tahun-2021`, `produk_hukum_id`
  `1261ff41-c359-4b2c-7596-08d99eb1213d`
- jdih title: "Harmonisasi Peraturan Perpajakan"
- jdih `tanggal_penetapan`: 2021-10-29
- `full_text_pdf`: `/api/download/A9FAAB97-ACA7-4F87-9FDC-FAA8123D1454/7TAHUN2021UU.pdf`
- HTTP: 200, `application/pdf`, 10,263,030 bytes
- SHA-256: `4e4be3e276bf327e6e9e8a4a031838f572feb4014c2476f6cea0d9a54dd38d5b`
- Cover page: "UNDANG-UNDANG REPUBLIK INDONESIA NOMOR 7 TAHUN 2021
  TENTANG HARMONISASI PERATURAN PERPAJAKAN"
- Register entry matches: number, title, `publishedAt` 2021-10-29.
- Re-confirmed on 2026-08-22 for the SOL-116 port: HTTP 200,
  `application/pdf`, 10,263,030 bytes, SHA-256 identical.

The pre-C1 register URL used a fabricated UUID
(`/download/8b4f2f5a-.../uu7-2021bt.pdf`) that returns 404 on jdih. The
monorepo register carried no UU 7/2021 entry; `UU-7-2021-HPP` is the port
of the verified `ev-uu-7-2021-hpp` entry.

## Entry 2 — `PMK-131-2024-ART3` and `PMK-131-2024-JDIH`

Both register entries cite the same verified document.

- jdih search result: `slug pmk-131-tahun-2024`, `produk_hukum_id`
  `d49c9b14-b14d-48d4-e51e-08dd29adf809`
- jdih title: "Perlakuan Pajak Pertambahan Nilai atas Impor Barang Kena
  Pajak, Penyerahan Barang Kena Pajak, Penyerahan Jasa Kena Pajak,
  Pemanfaatan Barang Kena Pajak Tidak Berwujud dari Luar Daerah Pabean
  di Dalam Daerah Pabean, dan Pemanfaatan Jasa Kena Pajak dari Luar
  Daerah Pabean di Dalam Daerah Pabean"
- jdih `tanggal_penetapan`: 2024-12-31
- `full_text_pdf`: `/api/download/F128868E-3CF6-4596-8407-C34EECA0E7BE/2024pmkeuangan131.pdf`
- HTTP: 200, `application/pdf`, 398,305 bytes
- SHA-256: `bd2b45907407c6640a6313500adb87c5a95854d79df3b53c1f5064ace71305cd`
- Cover page: "PERATURAN MENTERI KEUANGAN REPUBLIK INDONESIA NOMOR 131
  TAHUN 2024 TENTANG PERLAKUAN PAJAK PERTAMBAHAN NILAI ATAS IMPOR BARANG
  KENA PAJAK, ..."
- Pasal 3 (cited by the preset confirmation text) states the 12% rate on
  a `nilai lain` base of 11/12 of value, matching the preset calculation.
- Register entries now match: number, title, `publishedAt` 2024-12-31.
- Re-confirmed on 2026-08-22 for the SOL-116 port: HTTP 200,
  `application/pdf`, 398,305 bytes, SHA-256 identical.

The pre-C1 register URL used a placeholder UUID
(`/download/1a2b3c4d-.../pmk131-pmk010-2024.pdf`). The previous title
("Pedoman Pelaksanaan Penerbitan Faktur Pajak") did not match the
document; it is corrected to the official title. The monorepo
`PMK-131-2024-JDIH` entry used the short `/dok/pmk-131-tahun-2024` path
and `PMK-131-2024-ART3` used a `pajak.go.id` listing page; both are
replaced with the verified `full_text_pdf` path.

## Entry 3 — `PER-11-PJ-2025-ART129`

Verified 2026-08-22 (SOL-116) with the same method.

- jdih search result: `slug per-11pj2025`, `produk_hukum_id`
  `5ee751ad-7a3f-4ff4-ba39-9eba374d67f7`
- jdih title: "Ketentuan Pelaporan Pajak Penghasilan, Pajak Pertambahan
  Nilai, Pajak Penjualan atas Barang Mewah, dan Bea Meterai dalam rangka
  Pelaksanaan Sistem Inti Administrasi Perpajakan"
- jdih `tanggal_penetapan`: 2025-05-22
- `full_text_pdf`: `/api/download/A94EDEE5-E585-4EEB-B9E7-A76F616C92FB/PER-11_PJ_2025.pdf`
- HTTP: 200, `application/pdf`, 1,215,477 bytes
- SHA-256: `48087212a08c07582b87c0b3afb69632dbbb235092f475801e6e340a35444919`
- Cover page (OCR): "PERATURAN DIREKTUR JENDERAL PAJAK NOMOR
  PER-11/PJ/2025 TENTANG KETENTUAN PELAPORAN PAJAK PENGHASILAN, PAJAK
  PERTAMBAHAN NILAI, PAJAK PENJUALAN ATAS BARANG MEWAH, DAN BEA METERAI
  DALAM RANGKA PELAKSANAAN SISTEM INTI ADMINISTRASI PERPAJAKAN"
- Register entry matches: number, title, `publishedAt` 2025-05-22.

The previous URL was a `pajak.go.id` listing page; it is replaced with
the verified `full_text_pdf` path.

## Validation guard

`assertPresetRegisterValid` in `packages/core/src/tax/ppn-2025.ts`
continues to fail closed: it rejects any register URL that is not on
`pajak.go.id` or `jdih.kemenkeu.go.id`, any duplicate or empty
`evidenceId`, any unknown authority, and any duplicate or empty exclusion
code. `packages/core/src/tax/tax.test.ts` asserts the guard does not throw
on the shipped register, that the corrected entries ship the verified
jdih `full_text_pdf` paths, and that a non-government URL and a duplicate
`evidenceId` both throw.
