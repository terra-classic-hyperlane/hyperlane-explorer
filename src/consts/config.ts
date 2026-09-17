const isDevMode = process.env.NODE_ENV === 'development';
const version = process.env.NEXT_PUBLIC_VERSION ?? null;
// Same defaults as the client-side TcRegistry (src/tc-overrides/registry.ts): the
// Terra Classic registry fork, branch `public-warp`. Env vars only override them.
const registryUrl =
  process.env.NEXT_PUBLIC_REGISTRY_URL ||
  'https://github.com/terra-classic-hyperlane/hyperlane-registry';
const registryBranch = process.env.NEXT_PUBLIC_REGISTRY_BRANCH || 'public-warp';
const explorerApiKeys = JSON.parse(process.env.EXPLORER_API_KEYS || '{}');

interface Config {
  debug: boolean;
  version: string | null;
  apiUrl: string;
  explorerApiKeys: Record<string, string>;
  githubProxy?: string;
  registryUrl: string; // Registry repo URL (Terra Classic fork by default)
  registryBranch: string; // Registry branch (public-warp by default)
}

export const config: Config = Object.freeze({
  debug: isDevMode,
  version,
  apiUrl: 'https://explorer4.hasura.app/v1/graphql',
  explorerApiKeys,
  githubProxy: 'https://proxy.hyperlane.xyz',
  registryBranch,
  registryUrl,
});

// Based on https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/infra/config/environments/mainnet3/agent.ts
// Based on https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/infra/config/environments/testnet4/agent.ts
export const unscrapedChainsInDb = ['proteustestnet'];

export const debugIgnoredChains = ['treasure', 'treasuretopaz'];
