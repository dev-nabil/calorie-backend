export interface ProviderIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** A value read at call time (admin settings), or a fixed one (tests). */
export type Live<T> = T | (() => Promise<T>);
export const resolveLive = async <T>(v: Live<T>): Promise<T> => (typeof v === 'function' ? (v as () => Promise<T>)() : v);
