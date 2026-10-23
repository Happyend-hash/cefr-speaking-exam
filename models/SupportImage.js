import mongoose from 'mongoose';

/** A screenshot attached to a support message — shrunk in the browser first, so small. */
const supportImageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
    data: { type: Buffer, required: true }
  },
  { timestamps: true }
);

export default mongoose.model('SupportImage', supportImageSchema);
