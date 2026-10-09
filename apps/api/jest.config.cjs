/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['src/services/__tests__', 'src/lib/__tests__'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs' } }] },
  testTimeout: 30000,
  forceExit: true,
  globalSetup: './src/__tests__/global-setup.ts',
  setupFilesAfterEnv: ['./src/__tests__/jest-setup.ts'],
}
