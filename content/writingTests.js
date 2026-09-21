/**
 * Writing tests.
 *
 * Kept as code rather than in the database: a writing test is four short
 * passages that change rarely, and a file under version control means a
 * wording fix is reviewed, dated and reversible. Adding a test is adding an
 * object to this array — nothing else in the app needs to change.
 *
 * The task text is the teacher's, verbatim. Do not tidy it: the marker is told
 * to judge task fulfilment against exactly these words, and a student comparing
 * the screen against a printed paper must find the same sentences.
 *
 * `minWords` is the recommended minimum. It drives two things:
 *   - the word counter's target on screen
 *   - the school's under-length rule (see WRITING_LENGTH_RULE below)
 */

/**
 * The school's under-length rule, as Jamshid set it.
 *
 * A part whose word count falls below this share of its recommended minimum
 * is scored 0 for that part. Part 1.1 has no rule — a 50-word email is short
 * enough that the scale's own descriptors handle a thin answer.
 *
 * Note this is stricter than the board's descriptor text, which places
 * under-50% at band 2 and under-25% at band 1. It is applied as the school's
 * rule, deliberately.
 */
export const WRITING_LENGTH_RULE = Object.freeze({
  part11: null,
  part12: 0.25,
  part2: 0.5
});

/**
 * The official recommended minimums, used when a student checks their own
 * writing without a test attached. The exam format is fixed, so these do not
 * vary between papers.
 */
export const DEFAULT_MIN_WORDS = Object.freeze({
  part11: 50,
  part12: 120,
  part2: 180
});

/** A mock's time limit — all three parts together. */
export const WRITING_TIME_LIMIT_SECONDS = 60 * 60;

export const WRITING_TESTS = [
  {
    id: 'writing-01',
    title: 'Writing Mock 1',
    // Shared by Parts 1.1 and 1.2: both reply to the same message.
    stimulus: {
      intro: 'You are a student at a language school. You received this message from the school magazine editor.',
      text:
        'Dear Student,\n' +
        'We are starting a new section in the school magazine called Student Voices, and we’d like to include more opinions and ideas. What topics would you like to read about? Would you be interested in writing something? What would you write about? Please send us your suggestions by email.\n' +
        'The Editor'
    },
    parts: {
      part11: {
        task:
          'Write a letter to your friend, who is also a student at this school. Write about your feelings and what you think the magazine management should do about the situation.',
        wordGuide: 'Write about 50 words.',
        minWords: 50,
        maxWords: null
      },
      part12: {
        task:
          'Write a letter to the manager. Write about your feelings and what you think the magazine management should do about the situation.',
        wordGuide: 'Write about 120-150 words.',
        minWords: 120,
        maxWords: 150
      },
      part2: {
        task:
          'You are writing a blog post about the advantages and disadvantages of working from home. Explain your opinion and give examples to support your ideas.',
        wordGuide: 'Write 180–200 words.',
        minWords: 180,
        maxWords: 200
      }
    }
  }
];

export const writingTest = id => WRITING_TESTS.find(t => t.id === id) || null;

/**
 * The public shape of a test, for the student's screen. Everything in a
 * writing test is meant to be read by the candidate, so this is the whole test
 * — it exists so the route never hands over the internal object by reference.
 */
export function publicWritingTest(test) {
  if (!test) return null;
  return JSON.parse(JSON.stringify({ ...test, timeLimit: WRITING_TIME_LIMIT_SECONDS }));
}

export default {
  WRITING_TESTS,
  WRITING_LENGTH_RULE,
  DEFAULT_MIN_WORDS,
  WRITING_TIME_LIMIT_SECONDS,
  writingTest,
  publicWritingTest
};
