import { allocateByRatios, format, money, multiplyRate, sum } from '@stdio/core';

export default function HomePage() {
  // A smoke check. It proves the web app reads the shared money package.
  const lineTotal = money(1_250_000, 'EUR');
  const tax = multiplyRate(lineTotal, 21n, 100n);
  const grandTotal = sum([lineTotal, tax]);
  const paymentPlan = allocateByRatios(grandTotal, [30n, 40n, 30n]);

  return (
    <main>
      <h1>Stdio</h1>
      <p>Business management for interior and architecture studios.</p>

      <h2>Toolchain check</h2>
      <dl>
        <dt>Quote subtotal</dt>
        <dd>{format(lineTotal, 'en-US')}</dd>
        <dt>Tax at 21 percent</dt>
        <dd>{format(tax, 'en-US')}</dd>
        <dt>Grand total</dt>
        <dd>{format(grandTotal, 'en-US')}</dd>
        <dt>Payment plan 30 / 40 / 30</dt>
        <dd>{paymentPlan.map((share) => format(share, 'en-US')).join(' + ')}</dd>
      </dl>

      <p>
        The design is not applied yet. The Product Designer owns the visual design. Read
        <code> docs/adr/0001-stack.md </code>
        for the stack decision.
      </p>
    </main>
  );
}
