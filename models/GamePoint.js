import mongoose from 'mongoose';

/**
 * Points one student earned in one game (a round of Error Hunter, a Word
 * Duel, their share of a Taboo game). The games ranking adds these up — for
 * this week and for all time.
 */
const gamePointSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  game: { type: String, enum: ['error-hunter', 'duel', 'taboo'], required: true },
  points: { type: Number, required: true, min: 0 },
  at: { type: Date, default: Date.now },
  meta: { type: mongoose.Schema.Types.Mixed }
});

gamePointSchema.index({ at: -1 });
gamePointSchema.index({ user: 1, game: 1, at: -1 });

export default mongoose.model('GamePoint', gamePointSchema);
