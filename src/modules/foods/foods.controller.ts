import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BarcodeProductSchema, BarcodeSchema, type BarcodeProduct } from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiErrors, ZParam, ZResponse } from '../../common/zod/decorators';
import { FoodsService } from './foods.service';

@ApiTags('foods')
@ApiBearerAuth()
@Controller('foods')
export class FoodsController {
  constructor(private readonly foods: FoodsService) {}

  @Get('barcode/:code')
  @ZResponse(200, BarcodeProductSchema, 'A packaged product by barcode: your own label scan of it, else Open Food Facts. found=false is a normal answer; no AI, no charge')
  @ApiErrors(400, 401, 429, 503)
  lookup(@CurrentUser() u: AuthUser, @ZParam('code', BarcodeSchema) code: string): Promise<BarcodeProduct> {
    return this.foods.lookup(u.id, code);
  }
}
