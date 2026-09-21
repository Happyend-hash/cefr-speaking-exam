import { ErrorHunt } from './ErrorHunt.js';
import { DuelHub } from './DuelHub.js';
import { TabooGame } from './TabooGame.js';
import { voiceHub } from './VoiceRooms.js';
import { award } from './Games.js';

/**
 * The one instance of each game for this server, wired to the points store.
 */

export const errorHunt = new ErrorHunt();

/** A win against the practice bot counts half. */
export const BOT_FACTOR = 0.5;

export const duelHub = new DuelHub({
  onFinish({ bot, results, matchId }) {
    for (const r of results) {
      const points = Math.round(r.points * (bot ? BOT_FACTOR : 1));
      award(r.id, 'duel', points, { matchId, won: r.won, bot, opponent: r.opponent })
        .catch(error => console.error('Games: duel points not saved:', error.message));
    }
  }
});

export const taboo = new TabooGame({
  hub: voiceHub,
  onFinish({ roomId, scores }) {
    for (const s of scores) {
      if (s.points > 0) {
        award(s.id, 'taboo', s.points, { roomId })
          .catch(error => console.error('Games: taboo points not saved:', error.message));
      }
    }
  }
});

export default { errorHunt, duelHub, taboo };
