import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source. Next compiles them here.
  transpilePackages: ['@stdio/core', '@stdio/db'],
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default config;
