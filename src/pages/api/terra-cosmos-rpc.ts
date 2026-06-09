import type { NextApiRequest, NextApiResponse } from 'next';

import { createTcRegistry } from '../../tc-overrides/registry';

// Server-side proxy for Terra Classic RPC calls.
// Browsers can't call the Terra Classic RPCs directly (CORS), so the explorer forwards
// read-only queries (tx_search, block, ...) through this route.
//
// RPC endpoints are NOT hardcoded here: they're resolved from the Hyperlane registry by
// chain name, so mainnet/testnet endpoints stay in one source of truth and queries hit
// the right network. Resolving server-side (instead of trusting client-supplied URLs)
// also avoids turning this route into an open SSRF proxy.

// Read-only methods only.
const ALLOWED_METHODS = ['tx_search', 'tx', 'block', 'block_results'];

// Cache resolved RPC URLs per chain to avoid hitting the registry on every call.
const RPC_CACHE_TTL_MS = 5 * 60_000;
const rpcUrlCache = new Map<string, { urls: string[]; at: number }>();

async function resolveRpcUrls(chainName: string): Promise<string[]> {
  const cached = rpcUrlCache.get(chainName);
  if (cached && Date.now() - cached.at < RPC_CACHE_TTL_MS) return cached.urls;

  const registry = createTcRegistry();
  const metadata = await registry.getChainMetadata(chainName);
  const urls = (metadata?.rpcUrls ?? [])
    .map((u) => u.http)
    .filter((u): u is string => !!u && u.startsWith('https://'));
  rpcUrlCache.set(chainName, { urls, at: Date.now() });
  return urls;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!ALLOWED_METHODS.includes(body.method)) {
    return res.status(403).json({ error: 'Method not permitted' });
  }

  const chainName = body.chainName;
  if (typeof chainName !== 'string' || !chainName) {
    return res.status(400).json({ error: 'Missing chainName' });
  }

  let rpcUrls: string[];
  try {
    rpcUrls = await resolveRpcUrls(chainName);
  } catch (e: unknown) {
    return res.status(502).json({ error: `Failed to resolve RPCs: ${errMsg(e)}` });
  }
  if (!rpcUrls.length) {
    return res.status(404).json({ error: `No RPC endpoints for chain ${chainName}` });
  }

  // Forward only the JSON-RPC envelope (drop our chainName routing hint).
  const rpcPayload = { jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params };

  let lastError = 'All RPC endpoints failed';
  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcPayload),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    } catch (e: unknown) {
      lastError = errMsg(e);
    }
  }

  return res.status(502).json({ error: lastError });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
