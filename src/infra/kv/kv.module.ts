import { Global, Module } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { KvStore, MongoKvStore, type KvEntryDoc } from './kv-store';

@Global()
@Module({
  providers: [{ provide: KvStore, inject: [getModelToken('KvEntry')], useFactory: (model: Model<KvEntryDoc>): KvStore => new MongoKvStore(model) }],
  exports: [KvStore],
})
export class KvModule {}
