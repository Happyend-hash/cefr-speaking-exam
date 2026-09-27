import { VOCAB_RACE_UNITS } from './vocabRace.js';
import { VOCAB_RACE_UNITS_DESTINATION_B2 } from './vocabPackDestinationB2.js';
import { VOCAB_PACKS_EXTRA } from './vocabPacksExtra.js';

/**
 * Every vocabulary source Word Sprint can race with. A teacher picks one
 * pack, then one or more of its units -- see services/VocabRaceHub.js.
 */
export const VOCAB_PACKS = [
  { key: 'destination-b1', title: 'Destination B1', units: VOCAB_RACE_UNITS.map(u => ({ id: String(u.num), title: u.title, words: u.words })) },
  { key: 'destination-b2', title: 'Destination B2', units: VOCAB_RACE_UNITS_DESTINATION_B2.map(u => ({ id: String(u.num), title: u.title, words: u.words })) },
  ...VOCAB_PACKS_EXTRA
];

export default VOCAB_PACKS;
