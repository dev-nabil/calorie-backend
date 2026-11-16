import { DEFAULT_LOCALE, LOCALE_CODES, parseLocale, type LocaleCode } from '../../shared/locales';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES, type PutRemindersRequest, type ReminderInput, type ReminderSettings, type RemindersResponse, type ReminderView } from '../../shared';
import { translatorFor } from '../../shared/i18n';
import { dayKeyFor, startOfWeek } from '../../domain/day-keys';
import { MAX_PER_DAY, isOverdue, laterPause, linkFor, nextFireAt, validateReminders, type RingWindow, type Weekday } from '../../domain/reminders';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { KvStore } from '../../infra/kv/kv-store';
import { JobHandlers } from '../../jobs/jobs.module';
import { ContentService } from '../content/content.service';
import type { DeviceDoc, UserDoc } from '../users/schemas/users.schema';
import { UsersService } from '../users/users.service';
import type { MealDoc } from '../tracking/schemas/tracking.schema';
import { PushSender, type PushMessage } from './providers/push';
import type { ReminderDoc, ReminderSettingsDoc } from './schemas/reminders.schema';

export const REMINDER_JOB = 'reminders_tick';
const BATCH = 500;
const DEFAULT_SETTINGS: ReminderSettings = { quietHours: null, pausedUntil: null, discreet: true };

type Rule = Omit<ReminderDoc, '_id' | 'userId' | 'timezone' | 'nextFireAtUtc' | 'lastFiredAt'>;

/** One rule as stored: a once-a-day reminder keeps no end time; fields that do not belong to its type are cleared. */
function normalise(r: ReminderInput): Rule {
  return {
    type: r.type,
    time: r.time,
    days: (r.days ?? []) as Weekday[],
    enabled: r.enabled,
    everyHours: r.everyHours ?? null,
    endTime: r.everyHours ? (r.endTime ?? null) : null,
    category: r.type === 'log_meal' ? (r.category ?? null) : null,
    habit: r.type === 'habit' ? (r.habit ?? null) : null,
    label: r.type === 'habit' && r.habit === 'custom' ? (r.label ?? null) : null,
    checkIn: r.type === 'check_in' ? (r.checkIn ?? null) : null,
    pausedUntil: r.pausedUntil ?? null,
  };
}

const sameRule = (a: Rule, b: Rule): boolean =>
  a.type === b.type && a.time === b.time && a.days.join() === b.days.join() && (a.category ?? null) === (b.category ?? null) && (a.habit ?? null) === (b.habit ?? null) && (a.checkIn ?? null) === (b.checkIn ?? null);

@Injectable()
export class RemindersService implements OnModuleInit {
  private readonly logger = new Logger('Reminders');

  constructor(
    @InjectModel('Reminder') private readonly reminders: Model<ReminderDoc>,
    @InjectModel('ReminderSetting') private readonly settingsModel: Model<ReminderSettingsDoc>,
    @InjectModel('Device') private readonly devices: Model<DeviceDoc>,
    @InjectModel('User') private readonly users: Model<UserDoc>,
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    private readonly usersService: UsersService,
    private readonly handlers: JobHandlers,
    private readonly push: PushSender,
    private readonly kv: KvStore,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(REMINDER_JOB, () => this.tick(), 60_000);
    this.usersService.onTimezoneChange = (userId, tz) => this.retime(userId, tz);
  }

  private async settingsDoc(userId: Types.ObjectId): Promise<ReminderSettingsDoc | null> {
    return this.settingsModel.findOne({ userId }).lean<ReminderSettingsDoc>();
  }

  private static settingsView(d: ReminderSettingsDoc | null): ReminderSettings {
    return d ? { quietHours: d.quietHours ?? null, pausedUntil: d.pausedUntil ?? null, discreet: d.discreet ?? true } : { ...DEFAULT_SETTINGS };
  }

  private static windowFor(r: Pick<ReminderDoc, 'pausedUntil'>, s: ReminderSettings): RingWindow {
    return { quietHours: s.quietHours, pausedUntil: laterPause(r.pausedUntil, s.pausedUntil) };
  }

  async get(userId: string): Promise<RemindersResponse> {
    const user = await this.usersService.requireActive(userId);
    const [docs, settings] = await Promise.all([this.reminders.find({ userId: user._id }).sort({ time: 1 }).lean<ReminderDoc[]>(), this.settingsDoc(user._id)]);
    return {
      timezone: docs[0]?.timezone ?? user.timezone,
      maxPerDay: MAX_PER_DAY,
      reminders: docs.map((d) => ({
        id: d._id.toString(),
        type: d.type,
        time: d.time,
        days: d.days,
        enabled: d.enabled,
        everyHours: d.everyHours ?? null,
        endTime: d.everyHours ? (d.endTime ?? null) : null,
        category: (d.category ?? null) as ReminderView['category'],
        habit: (d.habit ?? null) as ReminderView['habit'],
        label: d.label ?? null,
        checkIn: (d.checkIn ?? null) as ReminderView['checkIn'],
        pausedUntil: d.pausedUntil ?? null,
        link: linkFor(d),
        nextFireAt: d.nextFireAtUtc ? d.nextFireAtUtc.toISOString() : null,
      })),
      settings: RemindersService.settingsView(settings),
    };
  }

  /**
   * Replaces the user's reminders. Reminders sent with their id keep it (an edit updates it); the others are new; any stored
   * reminder not in the list is deleted. nextFireAtUtc is precomputed (DST-safe, quiet hours and pauses skipped).
   */
  async put(userId: string, body: PutRemindersRequest): Promise<RemindersResponse> {
    const user = await this.usersService.requireActive(userId);
    const rules = body.reminders.map(normalise);
    const v = validateReminders(rules);
    if (!v.ok) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Reminders not allowed: ${v.reason}`, 422, { reason: v.reason, ...v.details });
    const timezone = body.timezone ?? user.timezone;
    const settings = await this.saveSettings(user._id, body.settings);
    const now = clock.now();
    const existing = new Set((await this.reminders.find({ userId: user._id }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()).map((d) => d._id.toString()));
    const keep: Types.ObjectId[] = [];
    for (const [i, rule] of rules.entries()) {
      const id = body.reminders[i]!.id;
      const _id = id && existing.has(id) && !keep.some((k) => k.toString() === id) ? new Types.ObjectId(id) : new Types.ObjectId();
      keep.push(_id);
      const nextFireAtUtc = rule.enabled ? nextFireAt({ ...rule, timezone }, now, RemindersService.windowFor(rule, settings)) : null;
      await this.reminders.updateOne({ _id, userId: user._id }, { $set: { ...rule, timezone, nextFireAtUtc }, $setOnInsert: { userId: user._id, lastFiredAt: null } }, { upsert: true });
    }
    await this.reminders.deleteMany({ userId: user._id, _id: { $nin: keep } });
    return this.get(userId);
  }

  private async saveSettings(userId: Types.ObjectId, patch: Partial<ReminderSettings> | undefined): Promise<ReminderSettings> {
    if (!patch || !Object.keys(patch).length) return RemindersService.settingsView(await this.settingsDoc(userId));
    const doc = await this.settingsModel
      .findOneAndUpdate({ userId }, { $set: patch, $setOnInsert: { userId } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true })
      .lean<ReminderSettingsDoc>();
    return RemindersService.settingsView(doc);
  }

  /**
   * One reminder from Milo chat (create_reminder): merged into the list through the same rules as PUT. An identical
   * reminder already there is returned as it is, so a repeat creates nothing.
   */
  async upsertOne(userId: string, input: ReminderInput, timezone?: string): Promise<{ response: RemindersResponse; reminderId: string }> {
    const user = await this.usersService.requireActive(userId);
    const docs = await this.reminders.find({ userId: user._id }).lean<ReminderDoc[]>();
    const rule = normalise(input);
    const same = docs.find((d) => sameRule(d as Rule, rule));
    if (same) {
      if (!same.enabled) await this.put(userId, { reminders: docs.map((d) => toInput(d, d._id.equals(same._id))), timezone: timezone ?? same.timezone });
      return { response: await this.get(userId), reminderId: same._id.toString() };
    }
    const list = [...docs.map((d) => toInput(d)), input];
    const res = await this.put(userId, { reminders: list, timezone: timezone ?? docs[0]?.timezone ?? user.timezone });
    const created = res.reminders.find((r) => !docs.some((d) => d._id.toString() === r.id));
    return { response: res, reminderId: created?.id ?? '' };
  }

  /** True when one more enabled reminder of this kind would pass the daily cap. */
  async wouldPassCap(userId: Types.ObjectId, input: ReminderInput): Promise<boolean> {
    const docs = await this.reminders.find({ userId }).lean<ReminderDoc[]>();
    return !validateReminders([...docs.map((d) => normalise(toInput(d))), normalise(input)]).ok;
  }

  /** Chat reviews (Milo buddy): the day/week review check-ins are skipped once it happened. */
  async markReviewed(userId: Types.ObjectId, kind: 'day' | 'week', dayKey: string): Promise<void> {
    const set = kind === 'day' ? { dayReviewedOn: dayKey } : { weekReviewedFrom: startOfWeek(dayKey) };
    await this.settingsModel.updateOne({ userId }, { $set: set, $setOnInsert: { userId, quietHours: null, pausedUntil: null, discreet: true } }, { upsert: true });
  }

  /** Recomputes after a timezone change (PATCH /me) so reminders follow the user (S-09). */
  async retime(userId: Types.ObjectId, timezone: string): Promise<void> {
    const now = clock.now();
    const settings = RemindersService.settingsView(await this.settingsDoc(userId));
    for (const r of await this.reminders.find({ userId }).lean<ReminderDoc[]>()) {
      await this.reminders.updateOne({ _id: r._id }, { $set: { timezone, nextFireAtUtc: r.enabled ? nextFireAt({ ...r, timezone }, now, RemindersService.windowFor(r, settings)) : null } });
    }
  }

  /**
   * Minute job: due reminders → FCM in batches of 500; at most 3 once-a-day pushes per local day (any time of day is allowed).
   * The rings of a repeating reminder are not counted. A ring more than 15 minutes late is skipped (no burst after
   * downtime). A meal reminder for a slot that already has a meal, and a review check-in after the review, are skipped.
   * Delivery today is on the phone (FCM is not configured); this path stays correct for when it is.
   */
  async tick(now = clock.now()): Promise<{ due: number; sent: number; skipped: number }> {
    const due = await this.reminders.find({ enabled: true, nextFireAtUtc: { $lte: now } }).limit(5000).lean<ReminderDoc[]>();
    if (!due.length) return { due: 0, sent: 0, skipped: 0 };
    const linesByLocale = new Map<string, Record<string, { title?: string; text?: string }>>();
    for (const code of LOCALE_CODES) {
      linesByLocale.set(code, ((await this.content.miloLines(code))?.data as { lines?: Record<string, { title?: string; text?: string }> } | undefined)?.lines ?? {});
    }
    const userIds = [...new Set(due.map((d) => d.userId.toString()))].map((id) => new Types.ObjectId(id));
    const users = new Map((await this.users.find({ _id: { $in: userIds } }, { status: 1, locale: 1 }).lean<UserDoc[]>()).map((u) => [u._id.toString(), u]));
    const settings = new Map((await this.settingsModel.find({ userId: { $in: userIds } }).lean<ReminderSettingsDoc[]>()).map((s) => [s.userId.toString(), s]));
    const tokens = new Map<string, string[]>();
    for (const d of await this.devices.find({ userId: { $in: userIds }, pushToken: { $ne: null } }, { userId: 1, pushToken: 1 }).lean<DeviceDoc[]>()) {
      const k = d.userId.toString();
      tokens.set(k, [...(tokens.get(k) ?? []), d.pushToken!]);
    }
    const messages: PushMessage[] = [];
    let skipped = 0;
    for (const r of due) {
      const uid = r.userId.toString();
      const s = settings.get(uid) ?? null;
      const view = RemindersService.settingsView(s);
      const day = dayKeyFor(r.nextFireAtUtc ?? now, r.timezone);
      const capKey = `remind:${uid}:${day}`;
      const counted = !r.everyHours && r.type !== 'weekly_review';
      const late = r.nextFireAtUtc ? isOverdue(r.nextFireAtUtc, now) : false;
      const done = !late && (await this.alreadyDone(r, s, day));
      const blocked = late || done || users.get(uid)?.status !== 'active' || (counted && Number((await this.kv.get(capKey)) ?? 0) >= MAX_PER_DAY);
      if (blocked || !tokens.get(uid)?.length) skipped++;
      else {
        if (counted) await this.kv.incr(capKey, 48 * 3600);
        const c = this.copy(r, parseLocale(users.get(uid)?.locale) ?? DEFAULT_LOCALE, linesByLocale, view.discreet);
        for (const token of tokens.get(uid)!) messages.push({ token, title: c.title, body: c.body, data: { type: `reminder.${r.type}`, reminderId: r._id.toString(), link: linkFor(r) } });
      }
      await this.reminders.updateOne({ _id: r._id }, { $set: { lastFiredAt: blocked ? r.lastFiredAt : now, nextFireAtUtc: nextFireAt(r, now, RemindersService.windowFor(r, view)) } });
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

  /** "Already done" suppression: the slot has a meal, or the review happened. */
  private async alreadyDone(r: ReminderDoc, s: ReminderSettingsDoc | null, day: string): Promise<boolean> {
    if (r.type === 'log_meal' && r.category) return (await this.meals.countDocuments({ userId: r.userId, date: day, category: r.category, deletedAt: null })) > 0;
    if (r.type === 'check_in' && r.checkIn === 'day_review') return s?.dayReviewedOn === day;
    if (r.type === 'weekly_review') return s?.weekReviewedFrom === startOfWeek(day);
    return false;
  }

  /** Notification copy: content lines for water and meals, server texts for the newer kinds; generic when discreet. */
  private copy(r: ReminderDoc, locale: LocaleCode, lines: Map<string, Record<string, { title?: string; text?: string }>>, discreet: boolean): { title: string; body: string } {
    const t = translatorFor(locale);
    if (discreet) return { title: t('reminder.discreet.title'), body: t('reminder.discreet.body') };
    if (r.type === 'water' || r.type === 'log_meal') {
      const c = lines.get(locale)?.[r.type === 'water' ? 'reminder.water' : 'reminder.logMeal'] ?? { title: 'Nouri', text: r.type === 'water' ? 'Time for some water.' : 'Time to add a meal?' };
      return { title: c.title ?? 'Nouri', body: c.text ?? '' };
    }
    if (r.type === 'weekly_review') return { title: 'Nouri', body: t('reminder.weeklyReview') };
    if (r.type === 'check_in') return { title: 'Nouri', body: t('reminder.checkIn.dayReview') };
    const habit = (r.habit ?? 'custom') as 'fruit_veg' | 'protein' | 'movement' | 'sleep' | 'custom';
    return { title: 'Nouri', body: habit === 'custom' && r.label ? r.label : t(`reminder.habit.${habit}`) };
  }
}

function toInput(d: ReminderDoc, enable = false): ReminderInput {
  return {
    id: d._id.toString(),
    type: d.type,
    time: d.time,
    days: d.days,
    enabled: enable || d.enabled,
    everyHours: d.everyHours ?? null,
    endTime: d.endTime ?? null,
    category: (d.category ?? null) as ReminderInput['category'],
    habit: (d.habit ?? null) as ReminderInput['habit'],
    label: d.label ?? null,
    checkIn: (d.checkIn ?? null) as ReminderInput['checkIn'],
    pausedUntil: d.pausedUntil ?? null,
  };
}
