import { type ExperimentDef } from '../../domain/experiments';

/** Defaults until the admin panel writes app_config (plan 8.9, 11, 12; OQ-18, OQ-19). */
export const CONFIG_DEFAULTS = {
  flags: {
    'paywall.onboarding': true,
    'targets.enabled': true,
    'voice.serverStt': false,
    'voice.cloudReplies': false,
    'voice.realtime': true,
    'coach.call': false,
    'features.storyRow': false,
    'features.waterGame': false,
    'features.levels': false,
    'features.dinnerIdeas': false,
    'features.arCamera': false,
  } as Record<string, boolean>,
  experiments: {
    'paywall.onboarding': { active: true, variants: [{ id: 'on', weight: 100 }, { id: 'off', weight: 0 }] },
    'freeScans.allowance': { active: false, variants: [{ id: '1', weight: 100 }, { id: '3', weight: 0 }] },
  } as Record<string, ExperimentDef>,
  minAppVersion: { ios: '1.0.0', android: '1.0.0' },
  legal: {
    termsUrl: 'https://nouri.example/terms',
    privacyUrl: 'https://nouri.example/privacy',
    subscriptionTermsUrl: 'https://nouri.example/subscription-terms',
    deleteAccountUrl: 'https://nouri.example/delete-account',
    supportUrl: 'https://nouri.example/support',
  } as Record<string, string>,
};
