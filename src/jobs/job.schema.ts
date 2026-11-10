import { Schema, type Types } from 'mongoose';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobDoc {
  _id: Types.ObjectId;
  name: string;
  payload: unknown;
  /** Dedupe key: a second enqueue with the same key is ignored while the first job is kept (one day after it finishes). */
  key?: string;
  status: JobStatus;
  runAt: Date;
  attempts: number;
  lockedUntil?: Date | null;
  error?: string | null;
  /** Set when the job finishes; the TTL index removes it then. */
  expiresAt?: Date | null;
}

/** Background jobs (collection `jobs`), processed in the API process by JobQueue. */
export const JobSchema = new Schema<JobDoc>(
  {
    name: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    key: { type: String },
    status: { type: String, required: true, default: 'queued' },
    runAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    error: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  { collection: 'jobs', timestamps: true, versionKey: false },
);
JobSchema.index({ status: 1, runAt: 1 });
JobSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
JobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface JobScheduleDoc {
  _id: string;
  lastRunAt: Date;
}

/** Last run of each repeating job, so a restart or a Render spin-down never skips or doubles a run. */
export const JobScheduleSchema = new Schema<JobScheduleDoc>({ _id: String, lastRunAt: { type: Date, required: true } }, { collection: 'job_schedules', versionKey: false });
