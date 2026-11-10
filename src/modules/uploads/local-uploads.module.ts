import { Module } from '@nestjs/common';
import { LocalUploadsController } from './local-uploads.controller';

/** File endpoints of the local storage driver; AppModule loads it only for the local disk driver (no S3 bucket configured). */
@Module({ controllers: [LocalUploadsController] })
export class LocalUploadsModule {}
