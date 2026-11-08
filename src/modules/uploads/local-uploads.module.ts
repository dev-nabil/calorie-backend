import { Module } from '@nestjs/common';
import { LocalUploadsController } from './local-uploads.controller';

/** File endpoints of the local storage driver; AppModule loads it only when STORAGE_DRIVER=local. */
@Module({ controllers: [LocalUploadsController] })
export class LocalUploadsModule {}
