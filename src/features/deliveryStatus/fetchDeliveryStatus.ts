import type { IRegistry } from '@hyperlane-xyz/registry';
import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import type { ChainMap } from '@hyperlane-xyz/sdk/types';
import { constants } from 'ethers';

import { Message, MessageStatus, MessageStub } from '../../types';
import { logger } from '../../utils/logger';
import { toDecimalNumber } from '../../utils/number';
import { getMailboxAddress } from '../chains/utils';
import { debugMessage } from '../debugger/debugMessage';
import { MessageDebugStatus } from '../debugger/types';
import type { ExplorerMultiProvider as MultiProtocolProvider } from '../hyperlane/sdkRuntime';
import { checkIsMessageDelivered } from '../messages/deliveryUtils';
import {
  MessageDeliveryFailingResult,
  MessageDeliveryPendingResult,
  MessageDeliveryStatusResponse,
  MessageDeliverySuccessResult,
} from './types';

export async function fetchDeliveryStatus(
  multiProvider: MultiProtocolProvider,
  registry: IRegistry,
  overrideChainMetadata: ChainMap<Partial<ChainMetadata>>,
  message: Message | MessageStub,
): Promise<MessageDeliveryStatusResponse> {
  const destName = multiProvider.tryGetChainName(message.destinationDomainId);
  if (!destName)
    throw new Error(
      `Cannot check delivery status, no chain name provided for domain ${message.destinationDomainId}`,
    );
  const destMailboxAddr = await getMailboxAddress(destName, overrideChainMetadata, registry);
  if (!destMailboxAddr)
    throw new Error(
      `Cannot check delivery status, no mailbox address provided for chain ${destName}`,
    );

  const { isDelivered, blockNumber, transactionHash } = await checkIsMessageDelivered(
    message.msgId,
    message.destinationDomainId,
    destMailboxAddr,
    multiProvider,
  );

  if (isDelivered) {
    const destName = multiProvider.tryGetChainName(message.destinationDomainId);
    const destProtocol = multiProvider.tryGetChainMetadata(message.destinationDomainId)?.protocol;
    const isCosmosDestination = destProtocol === 'cosmos';

    let txDetails: Awaited<ReturnType<typeof fetchTransactionDetails>>['tx'] = null;
    let blockTimestamp: number | null = null;
    let cosmosFrom: string | null = null;

    if (isCosmosDestination) {
      if (transactionHash) {
        const cosmosDetails = await fetchCosmosTransactionDetails(
          multiProvider,
          message.destinationDomainId,
          transactionHash,
        );
        blockTimestamp = cosmosDetails.blockTimestamp;
        cosmosFrom = cosmosDetails.from;
      }
    } else {
      const details = await fetchTransactionDetails(
        multiProvider,
        message.destinationDomainId,
        transactionHash,
        blockNumber,
      );
      txDetails = details.tx;
      blockTimestamp = details.blockTimestamp;
    }

    const result: MessageDeliverySuccessResult = {
      status: MessageStatus.Delivered,
      deliveryTransaction: {
        timestamp: toDecimalNumber(blockTimestamp ?? 0) * 1000,
        hash: transactionHash || constants.HashZero,
        from: cosmosFrom || txDetails?.from || constants.AddressZero,
        to: txDetails?.to || (destName ? destMailboxAddr : constants.AddressZero),
        blockHash: txDetails?.blockHash || constants.HashZero,
        blockNumber: toDecimalNumber(blockNumber || 0),
        mailbox: destName ? destMailboxAddr : constants.AddressZero,
        nonce: txDetails?.nonce || 0,
        gasLimit: toDecimalNumber(txDetails?.gasLimit || 0),
        gasPrice: toDecimalNumber(txDetails?.gasPrice || 0),
        effectiveGasPrice: toDecimalNumber(txDetails?.gasPrice || 0),
        gasUsed: toDecimalNumber(txDetails?.gasLimit || 0),
        cumulativeGasUsed: toDecimalNumber(txDetails?.gasLimit || 0),
        maxFeePerGas: toDecimalNumber(txDetails?.maxFeePerGas || 0),
        maxPriorityPerGas: toDecimalNumber(txDetails?.maxPriorityFeePerGas || 0),
      },
    };
    return result;
  } else {
    const originProtocol = multiProvider.tryGetChainMetadata(message.originDomainId)?.protocol;
    const destProtocol = multiProvider.tryGetChainMetadata(message.destinationDomainId)?.protocol;
    const canDebug = originProtocol === 'ethereum' && destProtocol === 'ethereum';

    if (!canDebug) {
      // debugMessage uses EVM providers — skip for non-EVM chains
      const result: MessageDeliveryPendingResult = { status: MessageStatus.Pending };
      return result;
    }

    const debugResult = await debugMessage(multiProvider, registry, overrideChainMetadata, message);
    const messageStatus =
      debugResult.status === MessageDebugStatus.NoErrorsFound
        ? MessageStatus.Pending
        : MessageStatus.Failing;
    const result: MessageDeliveryPendingResult | MessageDeliveryFailingResult = {
      status: messageStatus,
      debugResult,
    };
    return result;
  }
}

async function fetchTransactionDetails(
  multiProvider: MultiProtocolProvider,
  domainId: DomainId,
  txHash?: string,
  blockNumber?: number,
) {
  if (!txHash && !blockNumber) return { tx: null, blockTimestamp: null };
  logger.debug(`Searching for transaction details for ${txHash ?? `block ${blockNumber}`}`);
  const provider = multiProvider.getEthersV5Provider(domainId);
  const [tx, block] = await Promise.all([
    txHash ? provider.getTransaction(txHash) : Promise.resolve(null),
    blockNumber
      ? provider.getBlock(blockNumber).catch((error) => {
          logger.warn('Failed to fetch block for delivery timestamp', {
            domainId,
            txHash,
            blockNumber,
            error,
          });
          return null;
        })
      : Promise.resolve(null),
  ]);
  return { tx, blockTimestamp: block?.timestamp ?? null };
}

async function fetchCosmosTransactionDetails(
  multiProvider: MultiProtocolProvider,
  domainId: DomainId,
  txHash: string,
): Promise<{ blockTimestamp: number | null; from: string | null }> {
  const meta = multiProvider.tryGetChainMetadata(domainId) as
    | { restUrls?: Array<{ http: string }> }
    | null
    | undefined;
  const lcdUrl = meta?.restUrls?.[0]?.http;
  if (!lcdUrl) return { blockTimestamp: null, from: null };

  const hash = txHash.replace(/^0x/, '').toUpperCase();
  try {
    const res = await fetch(`${lcdUrl}/cosmos/tx/v1beta1/txs/${hash}`);
    if (!res.ok) return { blockTimestamp: null, from: null };
    const data = await res.json();
    const resp = data?.tx_response;
    if (!resp) return { blockTimestamp: null, from: null };

    const blockTimestamp = resp.timestamp ? Math.floor(new Date(resp.timestamp).getTime() / 1000) : null;
    // First signer is the relayer
    const from: string | null = data?.tx?.auth_info?.signer_infos?.[0]
      ? (data?.tx?.body?.messages?.[0]?.sender ?? null)
      : null;

    return { blockTimestamp, from };
  } catch (e) {
    logger.debug('Failed to fetch Cosmos delivery tx details', e);
    return { blockTimestamp: null, from: null };
  }
}
