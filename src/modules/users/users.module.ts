import { Global, Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { UsersService } from './users.service';

@Global()
@Module({
  controllers: [MeController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
