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

export function findPackage(key) {
  return PACKAGES.find(p => p.key === key) || null;
}
