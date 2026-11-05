import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { FoodRecordsService } from './food-records.service';

@Global()
@Module({
  controllers: [ContentController],
  providers: [ContentService, AppConfigService, FoodRecordsService],
  exports: [ContentService, AppConfigService, FoodRecordsService],
})
export class ContentModule {}
