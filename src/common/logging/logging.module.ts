import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { REQUEST_ID_HEADER } from '../../shared';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** pino JSON logs with a request id per request (X-Request-Id in and out). Never logs bodies or tokens. */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.LOG_LEVEL,
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const incoming = req.headers[REQUEST_ID_HEADER.toLowerCase()];
            const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
            res.setHeader(REQUEST_ID_HEADER, id);
            return id;
          },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-device-integrity"]'],
            remove: true,
          },
          customProps: () => ({ role: config.ROLE }),
          autoLogging: config.NODE_ENV !== 'test',
          transport:
            config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
