import type { AdminRole } from '../schemas/admin.schema';

export interface AdminSessionData {
  sid: string;
  adminId: string;
  email: string;
  role: AdminRole;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminSessionData;
    }
  }
}
