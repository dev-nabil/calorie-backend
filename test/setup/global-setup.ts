import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** Starts one in-memory replica set for all e2e files; each file uses its own database. */
export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // Index builds otherwise refuse to run when the disk has < 500 MB free.
    instanceOpts: [{ args: ['--setParameter', 'indexBuildMinAvailableDiskSpaceMB=0'] }],
  });
  (globalThis as Record<string, unknown>).__MONGO_REPLSET__ = replSet;
  process.env.TEST_MONGO_URI = replSet.getUri();
  
}
