/**
 * A ceiling on how many AI calls are in flight at once, server-wide.
 *
 * Marking one answer is one AI call taking ~19 seconds, almost all of it the
 * model writing feedback. The answers within an attempt are independent, so
 * they are marked in parallel — which is what turns a 150-second mock into a
 * ~20-second one — but parallelism without a ceiling is how a class of fifty
 * becomes four hundred simultaneous calls, and the API answers a burst like
 * that with 429s.
 *
 * So the limit is here, on the calls themselves, rather than on attempts. It
 * does not matter whether ten calls come from one student finishing a mock or
 * from ten students finishing one question: the server keeps the same number in
 * flight and the rest wait a moment. Waiting is invisible — the client polls
 * for its result, so a queued call simply looks like a slightly slower one.
 *
 * Sizing AI_CONCURRENCY: too low and a class queues; too high and the API rate
 * limit starts refusing calls, which the retry absorbs as delay — so pushing it
 * up past what the account allows buys nothing. 12 is a deliberate middle: one
 * full mock (8 answers) marks in a single wave, and a handful of students can
 * be marked at the same time.
 */

const DEFAULT_CONCURRENCY = 12;

class AICallLimiter {
  constructor(
    concurrency =
      Number(process.env.AI_CONCURRENCY) ||
      // Accept the older name so an existing deployment keeps working.
      Number(process.env.MARKING_CONCURRENCY) ||
      DEFAULT_CONCURRENCY
  ) {
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.waiting = [];
    this.peak = 0;
  }

  /** Queue a call; resolves with its result once it has had its turn. */
  run(job) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ job, resolve, reject });
      this.#pump();
    });
  }

  get stats() {
    return {
      running: this.running,
      waiting: this.waiting.length,
      concurrency: this.concurrency,
      peak: this.peak
    };
  }

  #pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const { job, resolve, reject } = this.waiting.shift();
      this.running += 1;
      this.peak = Math.max(this.peak, this.running);

      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          this.running -= 1;
          this.#pump();
        });
    }
  }
}

export default new AICallLimiter();
