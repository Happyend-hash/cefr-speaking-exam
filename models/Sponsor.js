import mongoose from 'mongoose';

/**
 * A sponsor's banner: a picture, where it links to, and which screens it
 * appears on. Sold directly by the teacher to local businesses; the view and
 * click counts are what the teacher shows the sponsor.
 */
export const PLACES = ['home', 'tests', 'club', 'rank'];

const sponsorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    link: { type: String, required: true, trim: true, maxlength: 500 },
    image: {
      key: String,          // file in the "sponsors" GridFS bucket
      contentType: String,
      bytes: Number
    },
    places: { type: [String], default: PLACES },
    active: { type: Boolean, default: true },
    // Optional end date: the banner stops showing after it.
    endsAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export default mongoose.model('Sponsor', sponsorSchema);
