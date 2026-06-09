import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMetadata } from '@hyperlane-xyz/sdk';
import type { ExplorerMultiProvider as MultiProtocolProvider } from '../../hyperlane/sdkRuntime';
import {
  ProtocolType,
  bytesToAddressCosmos,
  bytesToProtocolAddress,
  ensure0x,
  messageId,
  normalizeAddress,
  parseMessage,
  strip0x,
} from '@hyperlane-xyz/utils';

import { Message, MessageStatus } from '../../../types';
import { logger } from '../../../utils/logger';

const COSMOS_PI_TX_LIMIT = 20;

// CometBFT event attribute - keys/values are plain strings (not base64) in Terra Classic
interface CosmosAttr {
  key: string;
  value: string;
}

interface CosmosEvent {
  type: string;
  attributes: CosmosAttr[];
}

// Shape from tx_search RPC result
interface CosmosTxSearchResult {
  hash: string;
  height: string;
  tx_result: { code: number; events: CosmosEvent[] };
}

function attrsToMap(attrs: CosmosAttr[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs) out[a.key] = a.value ?? '';
  return out;
}

async function fetchBlockTimestamp(rpcUrl: string, height: string): Promise<number | undefined> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { height } }),
    });
    const data = await res.json();
    const timeStr: string | undefined = data?.result?.block?.header?.time;
    if (timeStr) return new Date(timeStr).getTime();
  } catch (e) {
    logger.debug('Failed to fetch block timestamp for height', height, e);
  }
  return undefined;
}

async function resolveMailboxBech32(
  chainMetadata: ChainMetadata<{ mailbox?: string }>,
  registry: IRegistry,
): Promise<string | undefined> {
  const mailboxHex =
    chainMetadata.mailbox || (await registry.getChainAddresses(chainMetadata.name))?.mailbox;
  if (!mailboxHex || !chainMetadata.bech32Prefix) return undefined;
  try {
    const bytes = Buffer.from(mailboxHex.replace(/^0x/, ''), 'hex');
    return bytesToAddressCosmos(bytes, chainMetadata.bech32Prefix);
  } catch (e) {
    logger.debug('Failed to convert mailbox bytes32 to bech32', e);
    return undefined;
  }
}

function eventsToMessage(
  events: CosmosEvent[],
  txHash: string,
  height: string,
  timestamp: number | undefined,
  chainMetadata: ChainMetadata<{ mailbox?: string }>,
  multiProvider: MultiProtocolProvider,
): Message | null {
  const dispatchEv = events.find((e) => e.type === 'wasm-mailbox_dispatch');
  if (!dispatchEv) return null;

  const attrs = attrsToMap(dispatchEv.attributes);
  const messageHex = attrs['message'];
  if (!messageHex) return null;

  // Extract IGP gas payment data from wasm-igp-core-pay-for-gas event (if present)
  const igpEv = events.find((e) => e.type === 'wasm-igp-core-pay-for-gas');
  const igpAttrs = igpEv ? attrsToMap(igpEv.attributes) : {};
  const igpPayment = igpAttrs['payment'];
  const igpGasAmount = igpAttrs['gas_amount'];

  try {
    const msgBytes = ensure0x(messageHex);
    const parsed = parseMessage(msgBytes);
    const msgId = messageId(msgBytes);
    const originChainId = multiProvider.getChainId(parsed.origin);
    const destinationChainId =
      multiProvider.tryGetChainId(parsed.destination) || parsed.destination;

    // Convert to protocol-native address format so lookups against the warp route registry match:
    // cosmos → bech32 (terra1...), EVM → checksum hex (0xA687...), Sealevel → base58
    const senderBytes = Uint8Array.from(Buffer.from(strip0x(ensure0x(parsed.sender)), 'hex'));
    const sender = bytesToProtocolAddress(
      senderBytes,
      chainMetadata.protocol as ProtocolType,
      chainMetadata.bech32Prefix,
    );
    const destMetadata = multiProvider.tryGetChainMetadata(parsed.destination);
    const recipientBytes = Uint8Array.from(Buffer.from(strip0x(ensure0x(parsed.recipient)), 'hex'));
    const recipient = destMetadata
      ? bytesToProtocolAddress(
          recipientBytes,
          destMetadata.protocol as ProtocolType,
          destMetadata.bech32Prefix,
        )
      : normalizeAddress(ensure0x(parsed.recipient));
    const mailboxAddr = chainMetadata.mailbox || attrs['_contract_address'] || '';

    return {
      id: '',
      msgId,
      sender,
      recipient,
      status: MessageStatus.Unknown,
      nonce: parsed.nonce,
      originChainId,
      destinationChainId,
      originDomainId: parsed.origin,
      destinationDomainId: parsed.destination,
      body: parsed.body,
      numPayments: igpPayment ? 1 : 0,
      totalPayment: igpPayment || '0',
      totalGasAmount: igpGasAmount || '0',
      origin: {
        timestamp: timestamp || 0,
        hash: txHash,
        from: sender,
        to: mailboxAddr,
        blockHash: '',
        blockNumber: parseInt(height, 10),
        mailbox: mailboxAddr,
        nonce: 0,
        gasLimit: 0,
        gasPrice: 0,
        effectiveGasPrice: 0,
        gasUsed: 0,
        cumulativeGasUsed: 0,
        maxFeePerGas: 0,
        maxPriorityPerGas: 0,
      },
      isPiMsg: true,
    };
  } catch (e) {
    logger.debug('Failed to parse Cosmos mailbox dispatch message', e);
    return null;
  }
}

async function searchByTxHash(
  rpcUrl: string,
  txHash: string,
  multiProvider: MultiProtocolProvider,
  chainMetadata: ChainMetadata<{ mailbox?: string }>,
): Promise<Message[]> {
  // Use LCD REST for tx lookup — the Tendermint RPC `tx` method can hash differently
  const lcdUrl = chainMetadata.restUrls?.[0]?.http;
  if (!lcdUrl) return [];
  const hash = txHash.replace(/^0x/, '').toUpperCase();
  try {
    const res = await fetch(`${lcdUrl}/cosmos/tx/v1beta1/txs/${hash}`);
    if (!res.ok) return [];
    const data = await res.json();
    const resp = data?.tx_response;
    if (!resp) return [];

    // LCD tx_response has logs[].events[] with plain text attributes
    const allEvents: CosmosEvent[] = [];
    for (const log of resp.logs || []) {
      allEvents.push(...(log.events || []));
    }
    const timestamp = resp.timestamp ? new Date(resp.timestamp).getTime() : undefined;
    const msg = eventsToMessage(allEvents, resp.txhash, resp.height, timestamp, chainMetadata, multiProvider);
    return msg ? [msg] : [];
  } catch (e) {
    logger.debug('Cosmos tx LCD lookup failed', e);
    return [];
  }
}

async function searchByMsgId(
  rpcUrl: string,
  mailboxBech32: string,
  searchMsgId: string,
  multiProvider: MultiProtocolProvider,
  chainMetadata: ChainMetadata<{ mailbox?: string }>,
): Promise<Message[]> {
  const normalizedId = searchMsgId.replace(/^0x/, '').toLowerCase();
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tx_search',
        params: {
          query: `execute._contract_address='${mailboxBech32}'`,
          order_by: 'desc',
          per_page: String(COSMOS_PI_TX_LIMIT),
          page: '1',
        },
      }),
    });
    const data = await res.json();
    const txs: CosmosTxSearchResult[] = data?.result?.txs || [];

    for (const tx of txs) {
      const idEv = tx.tx_result.events.find((e) => e.type === 'wasm-mailbox_dispatch_id');
      if (!idEv) continue;
      const attrs = attrsToMap(idEv.attributes);
      const mid = (attrs['message_id'] || '').replace(/^0x/, '').toLowerCase();
      if (mid === normalizedId) {
        const timestamp = await fetchBlockTimestamp(rpcUrl, tx.height);
        const msg = eventsToMessage(
          tx.tx_result.events,
          tx.hash,
          tx.height,
          timestamp,
          chainMetadata,
          multiProvider,
        );
        if (msg) return [msg];
      }
    }
  } catch (e) {
    logger.debug('Cosmos msgId search failed', e);
  }
  return [];
}

async function searchRecent(
  rpcUrl: string,
  mailboxBech32: string,
  multiProvider: MultiProtocolProvider,
  chainMetadata: ChainMetadata<{ mailbox?: string }>,
): Promise<Message[]> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tx_search',
        params: {
          query: `execute._contract_address='${mailboxBech32}'`,
          order_by: 'desc',
          per_page: String(COSMOS_PI_TX_LIMIT),
          page: '1',
        },
      }),
    });
    const data = await res.json();
    const txs: CosmosTxSearchResult[] = data?.result?.txs || [];

    // Fetch all block timestamps in parallel instead of sequentially
    const timestamps = await Promise.all(txs.map((tx) => fetchBlockTimestamp(rpcUrl, tx.height)));

    const messages: Message[] = [];
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const timestamp = timestamps[i];
      const msg = eventsToMessage(
        tx.tx_result.events,
        tx.hash,
        tx.height,
        timestamp,
        chainMetadata,
        multiProvider,
      );
      if (msg) messages.push(msg);
    }
    return messages;
  } catch (e) {
    logger.debug('Cosmos recent search failed', e);
    return [];
  }
}

export async function fetchMessagesFromPiCosmosChain(
  chainMetadata: ChainMetadata<{ mailbox?: string }>,
  query: { input: string },
  multiProvider: MultiProtocolProvider,
  registry: IRegistry,
): Promise<Message[]> {
  if (chainMetadata.protocol !== ProtocolType.Cosmos) return [];

  const rpcUrl = chainMetadata.rpcUrls?.[0]?.http;
  if (!rpcUrl) return [];

  const mailboxBech32 = await resolveMailboxBech32(chainMetadata, registry);
  if (!mailboxBech32) {
    logger.debug('No mailbox found for Cosmos chain', chainMetadata.name);
    return [];
  }

  const input = query.input.replace(/^0x/, '');
  logger.debug(`Cosmos PI query on ${chainMetadata.name}: "${input.slice(0, 16)}..."`);

  // 64-char hex = tx hash or msg id
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    const byTxHash = await searchByTxHash(rpcUrl, input, multiProvider, chainMetadata);
    if (byTxHash.length) return byTxHash;
    return searchByMsgId(rpcUrl, mailboxBech32, input, multiProvider, chainMetadata);
  }

  // Address or anything else → return recent dispatches
  return searchRecent(rpcUrl, mailboxBech32, multiProvider, chainMetadata);
}
