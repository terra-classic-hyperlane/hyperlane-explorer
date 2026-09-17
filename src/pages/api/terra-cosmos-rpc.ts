import type { NextApiRequest, NextApiResponse } from 'next';

import { resolveRegistryRpcUrls } from '../../utils/solanaRpc.server';

// Server-side proxy for Terra Classic RPC calls.
// Browsers can't call the Terra Classic RPCs directly (CORS), so the explorer forwards
// read-only queries (tx_search, block, ...) through this route.
//
// RPC endpoints are NOT hardcoded here: they're read from the chain's metadata.yaml in
// the Hyperlane registry, so mainnet/testnet endpoints live in one source of truth and
// queries hit the right network. Resolving server-side (rather than trusting client URLs)
// keeps this route from becoming an open SSRF proxy. Only the single small metadata file
// is fetched (and cached), so this stays well under the client search timeout.

const ALLOWED_METHODS = ['tx_search', 'tx', 'block', 'block_results'];

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

  // Restrict to a plain chain slug so it can't be used to fetch arbitrary registry paths.
  const chainName = body.chainName;
  if (typeof chainName !== 'string' || !/^[a-z0-9]+$/.test(chainName)) {
    return res.status(400).json({ error: 'Invalid chainName' });
  }

  let rpcUrls: string[];
  try {
    rpcUrls = await resolveRegistryRpcUrls(chainName);
  } catch (e: unknown) {
    return res.status(502).json({ error: `Failed to resolve RPCs: ${errMsg(e)}` });
  }
  if (!rpcUrls.length) {
    return res.status(404).json({ error: `No RPC endpoints for chain ${chainName}` });
  }

  // Forward only the JSON-RPC envelope (drop our chainName routing hint).
  const rpcPayload = {
    jsonrpc: '2.0',
    id: body.id ?? 1,
    method: body.method,
    params: body.params,
  };

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
      // A JSON-RPC error (e.g. a pruned node answering "height N is not available")
      // is a per-endpoint failure: fall through to the next RPC instead of returning it.
      if (data && typeof data === 'object' && 'error' in data && data.error) {
        lastError = errMsg(data.error?.data ?? data.error?.message ?? data.error);
        continue;
      }
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
