/** @type {import('jest').Config} */
const swc = [
  '@swc/jest',
  {
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      keepClassNames: true,
    },
    module: { type: 'commonjs' },
  },
];
const shared = {
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j|mj)s$': swc },
  // jose is ESM-only; compile it for Jest's CommonJS runtime.
  transformIgnorePatterns: ['/node_modules/(?!(\\.pnpm/)?jose)'],
};

module.exports = {
  testTimeout: 30000,
  projects: [
    { ...shared, displayName: 'unit', roots: ['<rootDir>/src'], testMatch: ['**/*.spec.ts'] },
    {
      ...shared,
      displayName: 'e2e',
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/setup/global-setup.ts',
      globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/openapi.ts'],
  coverageThreshold: { './src/domain/': { lines: 90, branches: 85, functions: 90, statements: 90 } },
};
