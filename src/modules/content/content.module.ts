import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';

@Global()
@Module({
  controllers: [ContentController],
  providers: [ContentService, AppConfigService],
  exports: [ContentService, AppConfigService],
})
export class ContentModule {}
