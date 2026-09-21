/**
 * Fluency measurement: pauses from the audio, fillers from the transcript.
 *
 * The audio here is synthetic — voiced bursts shaped like syllables, over room
 * noise — so the true pauses are known exactly and the detector can be checked
 * against them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findSpeech,
  describe,
  summarise,
  countFillers,
  countRepeats,
  countWords
} from '../services/FluencyService.js';
import { isPromptEcho } from '../services/TranscriptionService.js';

const SR = 16000;

/** Deterministic noise, so the tests never flake. */
function noiseSource(seed = 7) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff - 0.5;
  };
}

/** Build a recording from [['s', seconds] | ['p', seconds]] with room noise. */
function recording(plan, noiseLevel = 0.002) {
  const rand = noiseSource();
  const out = [];
  for (const [kind, seconds] of plan) {
    const n = Math.round(seconds * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = noiseLevel * rand();
      if (kind === 's') {
        const envelope = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 2.25 * t));
        const carrier = Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * rand();
        v += 0.25 * envelope * carrier;
      }
      out.push(Math.max(-1, Math.min(1, v)) * 32767);
    }
  }
  return Int16Array.from(out);
}

test('pauses are found where they are, and only between speech', () => {
  const audio = recording([
    ['p', 2.0], ['s', 3], ['p', 0.4], ['s', 2.5], ['p', 1.3], ['s', 4], ['p', 3.2], ['s', 2], ['p', 5]
  ]);
  const f = describe(findSpeech(audio), 'um I think erm that uh the the city is nice');

  assert.equal(f.measured, true);
  assert.ok(Math.abs(f.startDelaySec - 2.0) <= 0.1, `start ${f.startDelaySec}`);
  assert.equal(f.pauses, 3, 'the 0.4, 1.3 and 3.2 pauses; trailing silence is not a pause');
  assert.equal(f.longPauses, 2);
  assert.equal(f.veryLongPauses, 1);
  assert.ok(Math.abs(f.longestPauseSec - 3.2) <= 0.1, `longest ${f.longestPauseSec}`);
});

test('fluent speech with only word-boundary gaps has no long pauses', () => {
  const audio = recording([['p', 0.5], ['s', 6], ['p', 0.2], ['s', 5], ['p', 1]]);
  const f = describe(findSpeech(audio), 'I have been living here for ten years');
  assert.equal(f.longPauses, 0);
});

test('a recording with no voice is not measured rather than measured wrongly', () => {
  const f = describe(findSpeech(recording([['p', 8]])), '');
  assert.equal(f.measured, false);
});

test('fillers: hesitation sounds counted, real words never', () => {
  const { count, kinds } = countFillers('Umm I think, eee, the city is erm nice, uh, and mmm, like, well, you know, ah');
  assert.equal(count, 6); // umm, eee, erm, uh, mmm, ah
  assert.ok(kinds.umm && kinds.ee && kinds.erm && kinds.uh && kinds.mm);
  // "like", "well", "so", "you know" are often correct English; never counted.
  assert.equal(countFillers('Well, so, like, you know, I mean').count, 0);
  // Ordinary words that merely look short are not fillers.
  assert.equal(countFillers('Emma met her mum at home').count, 0);
});

test('repeats and meaningful word count ignore fillers', () => {
  assert.equal(countRepeats('I I think the the umm city'), 2);
  assert.equal(countWords('umm I think erm the city'), 4);
});

test('attempt summary weights by speaking time', () => {
  const short = { measured: true, speakingSec: 10, voicedSec: 9, words: 20, longPauses: 0, veryLongPauses: 0, longestPauseSec: 0.5, fillers: 0, repeats: 0, startDelaySec: 0.5 };
  const long = { measured: true, speakingSec: 110, voicedSec: 70, words: 150, longPauses: 11, veryLongPauses: 4, longestPauseSec: 4.1, fillers: 22, repeats: 3, startDelaySec: 4 };
  const s = summarise([short, long, { measured: false }]);
  assert.equal(s.answers, 2);
  assert.equal(s.longPausesPerMin, 5.5);   // 11 over 2 minutes
  assert.equal(s.fillersPerMin, 11);       // 22 over 2 minutes
  assert.equal(s.longestPauseSec, 4.1);
  assert.equal(s.slowStarts, 1);
});

test('the transcriber echoing its filler prompt is caught; real answers are not', () => {
  assert.equal(isPromptEcho('Umm, so, uh, I- I think, erm, the main thing is, mmm, well... eee, you know.'), true);
  assert.equal(isPromptEcho('Well, you know, I think so.'), false);
  assert.equal(isPromptEcho('I think the main thing is money.'), false);
  assert.equal(isPromptEcho(''), false);
});
