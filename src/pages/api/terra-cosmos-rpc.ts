import type { NextApiRequest, NextApiResponse } from 'next';

// Server-side proxy for Terra Classic RPC calls.
// Browser cannot call the RPC directly due to CORS restrictions on Terra Classic nodes.
// This route forwards tx_search queries to the RPC and returns the results.

const TC_RPCS = [
  'https://terra-classic-rpc.publicnode.com:443',
  'https://rpc.terra-classic.hexxagon.io',
  'https://api-lunc-rpc.binodes.com',
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Only allow tx_search and tx queries for safety
  const method = body.method;
  if (!['tx_search', 'tx', 'block', 'block_results'].includes(method)) {
    return res.status(403).json({ error: 'Method not permitted' });
  }

  let lastError: string = 'All RPC endpoints failed';
  for (const rpcUrl of TC_RPCS) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  return res.status(502).json({ error: lastError });
}
