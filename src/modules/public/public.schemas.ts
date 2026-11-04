import { Schema } from 'mongoose';

export const WaitlistSchema = new Schema(
  { email: { type: String, required: true }, source: String, utm: Schema.Types.Mixed, confirmedAt: { type: Date, default: null } },
  { collection: 'waitlist', timestamps: true },
);
WaitlistSchema.index({ email: 1 }, { unique: true });

export const DeletionRequestDbSchema = new Schema(
  { email: { type: String, required: true }, reason: String, status: { type: String, default: 'received' }, ip: String },
  { collection: 'deletion_requests', timestamps: true },
);
DeletionRequestDbSchema.index({ email: 1, createdAt: -1 });

