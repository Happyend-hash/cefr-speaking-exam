import AudioStorageService from './AudioStorageService.js';

/**
 * Deleting an attempt, in one place.
 *
 * Three routes now remove attempts — a student deleting one, a student deleting
 * a selection, and a teacher clearing old ones — and all three must behave
 * identically, because the rule they share is the one that matters: an attempt
 * is never removed while its recordings survive. If the audio cannot be
 * deleted, the attempt stays, so a student's history can never claim something
 * is gone while their voice is still stored in the database.
 *
 * Left duplicated per route, that rule would be right in the place someone
 * remembered it and wrong in the others.
 */
export async function removeResult(result) {
  if (result.status === 'evaluating') {
    return { ok: false, reason: 'it is being marked right now' };
  }

  const keys = result.taskResults.map(t => t.audioKey).filter(Boolean);
  const failed = [];
  for (const key of keys) {
    if (!(await AudioStorageService.delete(key))) failed.push(key);
  }

  if (failed.length) {
    return { ok: false, reason: `${failed.length} of ${keys.length} recordings could not be deleted` };
  }

  await result.deleteOne();
  return { ok: true, recordingsDeleted: keys.length };
}
