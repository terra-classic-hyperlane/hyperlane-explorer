import type { NextApiRequest, NextApiResponse } from 'next';

import { isValidChainSlug, resolveSolanaRpcUrls } from '../../utils/solanaRpc.server';

// Server-side proxy for Solana JSON-RPC calls used by the delivery-status check.
// Public Solana RPCs refuse browser-originated requests (403) and the private/paid RPC
// must not be exposed in the client bundle, so the browser talks to this route and the
// server forwards to `SOLANA_RPC_URL` (env) with the registry's public RPCs as fallback.
// Usage from the client: new Connection(`${origin}/api/solana-rpc?chain=solanamainnet`).

// Read-only methods needed by the explorer (delivery PDA + delivery transaction lookup).
const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getSignaturesForAddress',
  'getTransaction',
  'getBlockTime',
  'getSlot',
  'getLatestBlockhash',
  'getVersion',
]);

type RpcCall = {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function isAllowed(call: RpcCall) {
  return typeof call?.method === 'string' && ALLOWED_METHODS.has(call.method);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const chainName = req.query.chain ?? 'solanamainnet';
  if (!isValidChainSlug(chainName)) return res.status(400).json({ error: 'Invalid chain' });

  const body = req.body as RpcCall | RpcCall[] | undefined;
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || !calls.every(isAllowed)) {
    return res.status(403).json({ error: 'Method not permitted' });
  }

  let rpcUrls: string[];
  try {
    rpcUrls = await resolveSolanaRpcUrls(chainName);
  } catch (e: unknown) {
    return res.status(502).json({ error: `Failed to resolve RPCs: ${errMsg(e)}` });
  }
  if (!rpcUrls.length) return res.status(404).json({ error: `No RPC endpoints for ${chainName}` });

  let lastError = 'All RPC endpoints failed';
  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      // 401/403/429 are endpoint problems (auth, origin policy, rate limit): try the next one.
      if (!response.ok) {
        lastError = `${rpcUrl.split('?')[0]} -> HTTP ${response.status}`;
        continue;
      }
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
