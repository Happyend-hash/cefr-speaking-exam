import CourseStudent from '../models/CourseStudent.js';
import { syncLevel } from './CourseMonths.js';

/**
 * Moves planned "from next month" take effect on the 1st by themselves:
 * checked when the server starts and once an hour after that.
 */
export async function syncPlannedMoves(now = Date.now()) {
  const list = await CourseStudent.find({ removedAt: null, 'periods.1': { $exists: true } }).select('level monthlyFee periods removedAt');
  let moved = 0;
  for (const s of list) {
    if (syncLevel(s, now)) { await s.save(); moved += 1; }
  }
  if (moved) console.log(`Course: ${moved} planned group move(s) took effect`);
  return moved;
}

export function startMoveSync() {
  const tick = () => syncPlannedMoves().catch(error => console.error('Course move sync failed:', error.message));
  setTimeout(tick, 60 * 1000);
  return setInterval(tick, 60 * 60 * 1000);
}

export default { syncPlannedMoves, startMoveSync };
