/**
 * Mock-count packages sold through Click.
 *
 * Prices are in so'm, mocks are whole speaking-mock credits (added straight
 * to subscription.examsRemaining — no twelfths math, a package always buys
 * whole mocks). Real cost is ~2,190 so'm/mock (Sonnet 5 marking + Whisper +
 * Azure pronunciation, measured against actual production usage — see the
 * cost-verification work in the project docs), so every tier here clears a
 * comfortable margin even at the steepest bulk discount.
 *
 * key    mocks   price     so'm/mock   margin
 * single 1       5,000     5,000       56%
 * starter 5      22,000    4,400       50%
 * popular 10     38,000    3,800       42%
 * complete 20    70,000    3,500       37%
 */
export const PACKAGES = [
  { key: 'single', mocks: 1, price: 5000, label: '1 mock' },
  { key: 'starter', mocks: 5, price: 22000, label: '5 mock' },
  { key: 'popular', mocks: 10, price: 38000, label: '10 mock', badge: 'Mashhur' },
  { key: 'complete', mocks: 20, price: 70000, label: '20 mock' }
];

/**
 * Writing mocks (Jamshid, 2026-11-03): 2,000 so'm one, cheaper in bundles.
 * Marking a writing mock costs about 500 so'm (one AI reading), so every
 * tier keeps a margin. Sold by card transfer; the teacher adds them by hand.
 */
export const WRITING_PACKAGES = [
  { key: 'w1', mocks: 1, price: 2000, label: '1 mock' },
  { key: 'w5', mocks: 5, price: 9000, label: '5 mock' },
  { key: 'w10', mocks: 10, price: 16000, label: '10 mock', badge: 'Mashhur' },
  { key: 'w20', mocks: 20, price: 30000, label: '20 mock' }
];

/** Premium (2026-11-03): sold on its own — mocks no longer include it. */
export const PREMIUM_OFFER = { price: 15000, days: 30 };

export function findPackage(key) {
  return PACKAGES.find(p => p.key === key) || null;
}
