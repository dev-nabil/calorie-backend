export interface ProviderIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}
