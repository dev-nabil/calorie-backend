import { DEFAULT_LOCALE, LOCALE_CODES, parseLocale, type LocaleCode } from '../../shared/locales';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES, type PutRemindersRequest } from '../../shared';
import { dayKeyFor } from '../../domain/day-keys';
import { localMinutes } from '../../domain/nudges';
import { DEFAULT_QUIET_HOURS, inQuietHours, MAX_PER_DAY, nextFireAt, validateReminders, type Weekday } from '../../domain/reminders';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { KvStore } from '../../infra/kv/kv-store';
import { JobHandlers } from '../../jobs/jobs.module';
import { AppConfigService } from '../content/app-config.service';
import { ContentService } from '../content/content.service';
import type { DeviceDoc, UserDoc } from '../users/schemas/users.schema';
import { UsersService } from '../users/users.service';
import { PushSender, type PushMessage } from './providers/push';
import type { ReminderDoc } from './schemas/reminders.schema';

export const REMINDER_JOB = 'reminders_tick';
const BATCH = 500;

@Injectable()
export class RemindersService implements OnModuleInit {
  private readonly logger = new Logger('Reminders');

  constructor(
    @InjectModel('Reminder') private readonly reminders: Model<ReminderDoc>,
    @InjectModel('Device') private readonly devices: Model<DeviceDoc>,
    @InjectModel('User') private readonly users: Model<UserDoc>,
    private readonly usersService: UsersService,
    private readonly handlers: JobHandlers,
    private readonly push: PushSender,
    private readonly kv: KvStore,
    private readonly appConfig: AppConfigService,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(REMINDER_JOB, () => this.tick(), 60_000);
    this.usersService.onTimezoneChange = (userId, tz) => this.retime(userId, tz);
  }

  private quiet() {
    return this.appConfig.get('reminders.quietHours', DEFAULT_QUIET_HOURS);
  }

  async get(userId: string) {
    const user = await this.usersService.requireActive(userId);
    const docs = await this.reminders.find({ userId: user._id }).sort({ time: 1 }).lean<ReminderDoc[]>();
    return {
      timezone: docs[0]?.timezone ?? user.timezone,
      quietHours: await this.quiet(),
      maxPerDay: MAX_PER_DAY,
      reminders: docs.map((d) => ({ id: d._id.toString(), type: d.type, time: d.time, days: d.days, enabled: d.enabled, nextFireAt: d.nextFireAtUtc ? d.nextFireAtUtc.toISOString() : null })),
    };
  }

  /** Replaces the user's reminders; nextFireAtUtc is precomputed (DST-safe). */
  async put(userId: string, body: PutRemindersRequest) {
    const user = await this.usersService.requireActive(userId);
    const rules = body.reminders.map((r) => ({ ...r, days: (r.days ?? []) as Weekday[] }));
    const v = validateReminders(rules, await this.quiet());
    if (!v.ok) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Reminders not allowed: ${v.reason}`, 422, v.details);
    const timezone = body.timezone ?? user.timezone;
    const now = clock.now();
    await this.reminders.deleteMany({ userId: user._id });
    if (rules.length) {
      await this.reminders.insertMany(rules.map((r) => ({ userId: user._id, ...r, timezone, nextFireAtUtc: r.enabled ? nextFireAt({ ...r, timezone }, now) : null })));
    }
    return this.get(userId);
  }

  /** Recomputes after a timezone change (PATCH /me) so reminders follow the user (S-09). */
  async retime(userId: Types.ObjectId, timezone: string): Promise<void> {
    const now = clock.now();
    for (const r of await this.reminders.find({ userId }).lean<ReminderDoc[]>()) {
      await this.reminders.updateOne({ _id: r._id }, { $set: { timezone, nextFireAtUtc: r.enabled ? nextFireAt({ ...r, timezone }, now) : null } });
    }
  }

  /** Minute job: due reminders → FCM in batches of 500; quiet hours and 3 per local day enforced. */
  async tick(now = clock.now()): Promise<{ due: number; sent: number; skipped: number }> {
    const due = await this.reminders.find({ enabled: true, nextFireAtUtc: { $lte: now } }).limit(5000).lean<ReminderDoc[]>();
    if (!due.length) return { due: 0, sent: 0, skipped: 0 };
    const quiet = await this.quiet();
    const linesByLocale = new Map<string, Record<string, { title?: string; text?: string }>>();
    for (const code of LOCALE_CODES) {
      linesByLocale.set(code, ((await this.content.miloLines(code))?.data as { lines?: Record<string, { title?: string; text?: string }> } | undefined)?.lines ?? {});
    }
    const copy = (type: ReminderDoc['type'], locale: LocaleCode) =>
      linesByLocale.get(locale)?.[type === 'water' ? 'reminder.water' : 'reminder.logMeal'] ?? { title: 'Nouri', text: type === 'water' ? 'Time for some water.' : 'Time to add a meal?' };
    const users = new Map((await this.users.find({ _id: { $in: due.map((d) => d.userId) } }, { status: 1, locale: 1 }).lean<UserDoc[]>()).map((u) => [u._id.toString(), u]));
    const tokens = new Map<string, string[]>();
    for (const d of await this.devices.find({ userId: { $in: due.map((r) => r.userId) }, pushToken: { $ne: null } }, { userId: 1, pushToken: 1 }).lean<DeviceDoc[]>()) {
      const k = d.userId.toString();
      tokens.set(k, [...(tokens.get(k) ?? []), d.pushToken!]);
    }
    const messages: PushMessage[] = [];
    let skipped = 0;
    for (const r of due) {
      const uid = r.userId.toString();
      const local = localMinutes(now, r.timezone);
      const hhmm = `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`;
      const capKey = `remind:${uid}:${dayKeyFor(now, r.timezone)}`;
      const blocked = users.get(uid)?.status !== 'active' || inQuietHours(hhmm, quiet) || Number((await this.kv.get(capKey)) ?? 0) >= MAX_PER_DAY;
      if (blocked || !tokens.get(uid)?.length) skipped++;
      else {
        await this.kv.incr(capKey, 48 * 3600);
        const c = copy(r.type, parseLocale(users.get(uid)?.locale) ?? DEFAULT_LOCALE);
        for (const token of tokens.get(uid)!) messages.push({ token, title: c.title ?? 'Nouri', body: c.text ?? '', data: { type: `reminder.${r.type}`, reminderId: r._id.toString() } });
      }
      await this.reminders.updateOne({ _id: r._id }, { $set: { lastFiredAt: blocked ? r.lastFiredAt : now, nextFireAtUtc: nextFireAt(r, now) } });
    }
    let sent = 0;
    for (let i = 0; i < messages.length; i += BATCH) {
      const res = await this.push.sendBatch(messages.slice(i, i + BATCH));
      sent += res.sent;
      if (res.invalidTokens.length) await this.devices.updateMany({ pushToken: { $in: res.invalidTokens } }, { $set: { pushToken: null } });
    }
    this.logger.log({ due: due.length, sent, skipped }, 'reminders tick');
    return { due: due.length, sent, skipped };
  }
}
