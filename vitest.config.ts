import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts', 'web/src/**/*.test.tsx'], testTimeout: 20_000, hookTimeout: 60_000 } });
