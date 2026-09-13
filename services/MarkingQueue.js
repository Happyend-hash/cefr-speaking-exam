/**
 * A small concurrency limiter for marking.
 *
 * Marking one attempt means one AI call per answer, run in order. That is fine
 * for one student. When a class of fifty finishes together it is four hundred
 * calls arriving at once, and nothing in the app limited how many were in
 * flight: the API answers a burst like that with 429s, and a 429 was recorded
 * as a failed answer — so students got blank marks because their classmates
 * submitted at the same moment.
 *
 * This keeps a fixed number of attempts marking at a time and makes the rest
 * wait their turn. Waiting is invisible to the student: the client polls for the
 * result, so a queued attempt looks exactly like a slow one.
 *
 * Deliberately in-process and dependency-free. A Redis-backed queue would
 * survive restarts, but it is another service to run and pay for, and the
 * restart case is already covered: an attempt left in 'evaluating' for more
 * than ten minutes can be submitted again.
 */

const DEFAULT_CONCURRENCY = 4;

class MarkingQueue {
  constructor(concurrency = Number(process.env.MARKING_CONCURRENCY) || DEFAULT_CONCURRENCY) {
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.waiting = [];
  }

  /** Queue a job; resolves with its result once it has had its turn. */
  run(job) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ job, resolve, reject });
      this.#pump();
    });
  }

  get stats() {
    return { running: this.running, waiting: this.waiting.length, concurrency: this.concurrency };
  }

  #pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const { job, resolve, reject } = this.waiting.shift();
      this.running += 1;

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

export default new MarkingQueue();
