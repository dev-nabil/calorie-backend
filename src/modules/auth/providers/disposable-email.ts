import disposableDomains from 'disposable-email-domains/index.json';

const DISPOSABLE = new Set<string>(disposableDomains);

/** S-03: disposable domains are rejected at sign-up. Subdomains of a listed domain count too. */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  return false;
}
