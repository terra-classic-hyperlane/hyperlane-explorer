// Server-only helpers for Solana (Sealevel) RPC resolution. Never import from client code:
// the private RPC URL lives in a plain (non NEXT_PUBLIC_) env var so it stays out of the bundle.
import { parse as parseYaml } from 'yaml';

import { TC_REGISTRY_BRANCH, TC_REGISTRY_URL } from '../tc-overrides/registry';

// Private/paid RPCs by chain name. Public Solana RPCs (api.mainnet-beta.solana.com) reject
// browser-originated calls and rate-limit aggressively, so production should set these.
const PRIVATE_RPC_ENV: Record<string, string | undefined> = {
  solanamainnet: process.env.SOLANA_RPC_URL,
  solanatestnet: process.env.SOLANA_TESTNET_RPC_URL,
};

const RAW_CHAINS_BASE = `${TC_REGISTRY_URL.replace(
  'https://github.com',
  'https://raw.githubusercontent.com',
)}/${TC_REGISTRY_BRANCH}/chains`;

const CACHE_TTL_MS = 5 * 60_000;
const registryRpcCache = new Map<string, { urls: string[]; at: number }>();

export function isValidChainSlug(chainName: unknown): chainName is string {
  return typeof chainName === 'string' && /^[a-z0-9]+$/.test(chainName);
}

export function getPrivateSolanaRpcUrl(chainName: string): string | undefined {
  const url = PRIVATE_RPC_ENV[chainName];
  return url && url.startsWith('https://') ? url : undefined;
}

// RPC endpoints declared in the chain's registry metadata (public fallbacks).
export async function resolveRegistryRpcUrls(chainName: string): Promise<string[]> {
  const cached = registryRpcCache.get(chainName);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.urls;

  const res = await fetch(`${RAW_CHAINS_BASE}/${chainName}/metadata.yaml`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`registry metadata ${res.status}`);
  const metadata = parseYaml(await res.text()) as {
    rpcUrls?: Array<{ http?: string }>;
  };
  const urls = (metadata?.rpcUrls ?? [])
    .map((u) => u.http)
    .filter((u): u is string => !!u && u.startsWith('https://'));
  registryRpcCache.set(chainName, { urls, at: Date.now() });
  return urls;
}

// Private RPC first (when configured), then the registry's public endpoints.
export async function resolveSolanaRpcUrls(chainName: string): Promise<string[]> {
  const privateUrl = getPrivateSolanaRpcUrl(chainName);
  const publicUrls = await resolveRegistryRpcUrls(chainName).catch(() => [] as string[]);
  return privateUrl ? [privateUrl, ...publicUrls.filter((u) => u !== privateUrl)] : publicUrls;
}
