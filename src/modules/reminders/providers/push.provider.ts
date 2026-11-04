import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { ConsolePushSender, FcmPushSender, PushSender } from './push';

export const pushProvider = {
  provide: PushSender,
  inject: [APP_CONFIG],
  useFactory: (c: AppConfig): PushSender => (c.FIREBASE_SERVICE_ACCOUNT_JSON ? new FcmPushSender(c.FIREBASE_SERVICE_ACCOUNT_JSON) : new ConsolePushSender()),
};
