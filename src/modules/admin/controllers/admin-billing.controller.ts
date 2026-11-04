import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import { AdminBillingEventListSchema, AdminReasonRequestSchema, AdminStatusResultSchema, AdminSubscriptionListSchema } from '../../../shared';
import { ApiError } from '../../../common/errors/api-error';
import { ZBody, ZQuery, ZResponse } from '../../../common/zod/decorators';
import type { BillingEventDoc, SubscriptionDoc } from '../../billing/schemas/billing.schema';
import { BillingEventsService } from '../../billing/services/billing-events.service';
import type { UserDoc } from '../../users/schemas/users.schema';
import { Admin } from './admin-auth.controller';
import { AuditService } from '../services/audit.service';
import { CurrentAdmin } from '../security/admin.decorators';
import { type AdminSessionData } from '../security/admin-session.types';

const SubQuery = z.strictObject({ status: z.string().max(32).optional(), cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
const EventQuery = SubQuery.extend({ userId: z.string().max(64).optional() });
const product = (id: string) => (/year|annual/i.test(id) ? 'plus_yearly' : 'plus_monthly');
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** M7-T6: subscriptions and billing events with replay. */
@ApiTags('admin')
@Controller('admin')
export class AdminBillingController {
  constructor(
    @InjectModel('Subscription') private readonly subs: Model<SubscriptionDoc>,
    @InjectModel('BillingEvent') private readonly events: Model<BillingEventDoc>,
    @InjectModel('User') private readonly users: Model<UserDoc>,
    private readonly billing: BillingEventsService,
    private readonly audit: AuditService,
  ) {}

  @Admin('subscriptions.view')
  @Get('subscriptions')
  @ZResponse(200, AdminSubscriptionListSchema)
  async subscriptions(@ZQuery(SubQuery) q: z.infer<typeof SubQuery>) {
    const filter: Record<string, unknown> = q.status ? { status: q.status } : {};
    if (q.cursor && Types.ObjectId.isValid(q.cursor)) filter._id = { $lt: new Types.ObjectId(q.cursor) };
    const limit = q.limit ?? 100;
    const docs = await this.subs.find(filter).sort({ _id: -1 }).limit(limit + 1).lean<SubscriptionDoc[]>();
    const emails = new Map((await this.users.find({ _id: { $in: docs.map((d) => d.userId) } }, { email: 1 }).lean<{ _id: Types.ObjectId; email: string }[]>()).map((u) => [u._id.toString(), u.email]));
    const items = docs.slice(0, limit).map((d) => ({
      id: d._id.toString(),
      userId: d.userId.toString(),
      userEmail: emails.get(d.userId.toString()) ?? '',
      product: product(d.productId),
      store: d.store,
      status: d.status,
      autoRenew: d.autoRenew,
      startedAt: iso(d.startedAt) ?? iso(d.createdAt),
      currentPeriodEnd: iso(d.currentPeriodEnd),
      gracePeriodEndsAt: iso(d.gracePeriodEnd),
    }));
    return { items, nextCursor: docs.length > limit ? items.at(-1)!.id : null };
  }

  @Admin('subscriptions.view')
  @Get('billing-events')
  @ZResponse(200, AdminBillingEventListSchema)
  async billingEvents(@ZQuery(EventQuery) q: z.infer<typeof EventQuery>) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.userId && Types.ObjectId.isValid(q.userId)) filter.userId = new Types.ObjectId(q.userId);
    if (q.cursor && Types.ObjectId.isValid(q.cursor)) filter._id = { $lt: new Types.ObjectId(q.cursor) };
    const limit = q.limit ?? 100;
    const docs = await this.events.find(filter).sort({ _id: -1 }).limit(limit + 1).lean<BillingEventDoc[]>();
    const items = docs.slice(0, limit).map((d) => {
      const p = d.payload as { product_id?: string; store?: string };
      return {
        id: d._id.toString(),
        externalId: d.eventId,
        userId: d.userId?.toString() ?? '',
        type: d.type,
        store: p.store === 'PLAY_STORE' ? 'play_store' : 'app_store',
        product: product(p.product_id ?? ''),
        receivedAt: iso(d.receivedAt),
        processedAt: iso(d.processedAt),
        status: d.status === 'ignored' ? 'processed' : d.status,
        error: d.error,
      };
    });
    return { items, nextCursor: docs.length > limit ? items.at(-1)!.id : null };
  }

  @Admin('billing.replay')
  @Post('billing-events/:id/replay')
  @HttpCode(200)
  @ZResponse(200, AdminStatusResultSchema)
  async replay(@Param('id') id: string, @ZBody(AdminReasonRequestSchema) body: { reason: string }, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const doc = Types.ObjectId.isValid(id) ? await this.events.findById(id).lean<BillingEventDoc>() : null;
    if (!doc) throw ApiError.notFound();
    const result = await this.billing.process(doc.eventId, true);
    await this.audit.log(admin, req, { action: 'billing.replay', targetType: 'billing_event', targetId: id, reason: body.reason, diff: result });
    return result;
  }
}
