import type { IRegistry } from '@hyperlane-xyz/registry';
import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import { ensure0x, timeout } from '@hyperlane-xyz/utils';
import { useQuery } from '@tanstack/react-query';

import { useMultiProviderVersion, useReadyMultiProvider, useRegistry } from '../../../store';
import { Message, MessageStatus, MessageStatusFilter } from '../../../types';
import { logger } from '../../../utils/logger';
import { getMailboxAddress, isEvmChain, isPiChain } from '../../chains/utils';
import { useScrapedDomains } from '../../chains/queries/useScrapedChains';
import { checkIsMessageDelivered } from '../deliveryUtils';
import type { ExplorerMultiProvider as MultiProtocolProvider } from '../../hyperlane/sdkRuntime';
import { isValidSearchQuery } from '../queries/useMessageQuery';
import { PiMessageQuery, PiQueryType, fetchMessagesFromPiChain } from './fetchPiChainMessages';
import { fetchMessagesFromPiCosmosChain } from './fetchPiCosmosChainMessages';

const MESSAGE_SEARCH_TIMEOUT = 10_000; // 10s
// Cap concurrent destination-mailbox delivery checks so a large recent feed doesn't fan out
// into a burst of RPC calls.
const DELIVERY_CHECK_CONCURRENCY = 8;

// PI Cosmos dispatches are returned with MessageStatus.Unknown (the Cosmos fetch can't tell
// whether the message was delivered). When the user filters by delivery status, resolve each
// message's real status by checking the destination chain's mailbox, mirroring the message
// details page. Skipped when statusFilter is 'all' to avoid adding RPC latency to the feed.
async function enrichWithDeliveryStatus(
  messages: Message[],
  multiProvider: MultiProtocolProvider,
  registry: IRegistry,
): Promise<Message[]> {
  const result = messages.slice();
  for (let i = 0; i < result.length; i += DELIVERY_CHECK_CONCURRENCY) {
    const batch = result.slice(i, i + DELIVERY_CHECK_CONCURRENCY);
    const statuses = await Promise.all(
      batch.map(async (m) => {
        try {
          const destName = multiProvider.tryGetChainName(m.destinationDomainId);
          if (!destName) return m.status;
          const mailboxAddr = await getMailboxAddress(destName, {}, registry);
          if (!mailboxAddr) return m.status;
          const { isDelivered } = await checkIsMessageDelivered(
            m.msgId,
            m.destinationDomainId,
            mailboxAddr,
            multiProvider,
          );
          return isDelivered ? MessageStatus.Delivered : MessageStatus.Pending;
        } catch (e) {
          logger.debug('Delivery status enrichment failed for', m.msgId, e);
          return m.status;
        }
      }),
    );
    statuses.forEach((status, j) => {
      result[i + j] = { ...result[i + j], status };
    });
  }
  return result;
}

// Query 'Permissionless Interoperability (PI)' chains using
// override chain metadata in store state
export function usePiChainMessageSearchQuery({
  sanitizedInput,
  startTimeFilter,
  endTimeFilter,
  piQueryType,
  pause,
  originChainFilter,
  destinationChainFilter,
  statusFilter = 'all',
}: {
  sanitizedInput: string;
  startTimeFilter?: number | null;
  endTimeFilter?: number | null;
  piQueryType?: PiQueryType;
  pause: boolean;
  originChainFilter?: string | null;
  destinationChainFilter?: string | null;
  statusFilter?: MessageStatusFilter;
}) {
  const { scrapedDomains: scrapedChains } = useScrapedDomains();
  const multiProvider = useReadyMultiProvider();
  const multiProviderVersion = useMultiProviderVersion();
  const registry = useRegistry();

  const { isLoading, isError, data } = useQuery({
    queryKey: [
      'usePiChainMessageSearchQuery',
      sanitizedInput,
      startTimeFilter,
      endTimeFilter,
      multiProviderVersion,
      registry,
      pause,
      originChainFilter,
      destinationChainFilter,
      statusFilter,
    ],
    queryFn: async () => {
      if (pause || !multiProvider) return [];

      const hasInput = !!sanitizedInput;
      const isValidInput = isValidSearchQuery(sanitizedInput);
      const allChains: ChainMetadata[] = Object.values(multiProvider.metadata);

      const cosmosPiChains = allChains.filter(
        (c) =>
          c.domainId !== undefined &&
          c.protocol === 'cosmos' &&
          isPiChain(multiProvider, scrapedChains, c.domainId),
      );

      // No search text → show recent dispatches. If the filter names a Cosmos PI chain
      // (i.e. Terra Classic itself), read just that chain. If it names a non-TC counterpart
      // (e.g. a TC<->Sepolia route's Sepolia side), Hasura has no TC-origin rows, so read
      // recent dispatches from all TC Cosmos chains and let the caller narrow by domain —
      // this is what surfaces the TC->counterpart direction. With no filter (landing) we also
      // aggregate across all TC Cosmos chains.
      const chainFilterName = originChainFilter || destinationChainFilter;
      if (!hasInput) {
        const filterIsCosmosPiChain =
          !!chainFilterName && cosmosPiChains.some((c) => c.name === chainFilterName);
        const recentChains = filterIsCosmosPiChain
          ? cosmosPiChains.filter((c) => c.name === chainFilterName)
          : cosmosPiChains;
        if (!recentChains.length) return [];
        logger.debug(
          'Fetching recent Cosmos PI messages for chains:',
          recentChains.map((c) => c.name).join(', '),
        );
        const settled = await Promise.allSettled(
          recentChains.map((c) =>
            timeout(
              fetchMessagesFromPiCosmosChain(c, { input: 'recent' }, multiProvider, registry),
              MESSAGE_SEARCH_TIMEOUT,
              'cosmos pi recent timeout',
            ),
          ),
        );
        const recentMessages = settled
          .filter((r): r is PromiseFulfilledResult<Message[]> => r.status === 'fulfilled')
          .map((r) => r.value)
          .flat();
        if (statusFilter === 'all') return recentMessages;
        return enrichWithDeliveryStatus(recentMessages, multiProvider, registry);
      }

      if (!isValidInput) return [];
      logger.debug('Starting PI Chain message search for:', sanitizedInput);
      const query = { input: ensure0x(sanitizedInput) };

      const evmPiChains = allChains.filter(
        (c) =>
          c.domainId !== undefined &&
          isEvmChain(multiProvider, c.domainId) &&
          isPiChain(multiProvider, scrapedChains, c.domainId),
      );

      try {
        const results = await Promise.allSettled([
          ...evmPiChains.map((c) => fetchMessages(c, query, multiProvider, registry, piQueryType)),
          ...cosmosPiChains.map((c) =>
            timeout(
              fetchMessagesFromPiCosmosChain(c, query, multiProvider, registry),
              MESSAGE_SEARCH_TIMEOUT,
              'cosmos pi search timeout',
            ),
          ),
        ]);
        return results
          .filter(
            (result): result is PromiseFulfilledResult<Message[]> => result.status === 'fulfilled',
          )
          .map((result) => result.value)
          .flat();
      } catch {
        logger.debug('No PI messages found for query:', sanitizedInput);
        return [];
      }
    },
    retry: false,
  });

  return {
    isFetching: isLoading,
    isError,
    hasRun: !!data,
    messageList: data || [],
    isMessagesFound: !!data?.length,
  };
}

export function usePiChainMessageQuery({
  messageId,
  pause,
}: {
  messageId: string;
  pause: boolean;
}) {
  const { hasRun, isError, isFetching, messageList } = usePiChainMessageSearchQuery({
    sanitizedInput: messageId,
    startTimeFilter: null,
    endTimeFilter: null,
    piQueryType: PiQueryType.MsgId,
    pause,
  });

  const message = messageList?.length ? messageList[0] : null;
  const isMessageFound = !!message;

  return {
    isFetching,
    isError,
    hasRun,
    message,
    isMessageFound,
  };
}

async function fetchMessages(
  chainMetadata: ChainMetadata,
  query: PiMessageQuery,
  multiProvider: MultiProtocolProvider,
  registry: IRegistry,
  queryType?: PiQueryType,
): Promise<Message[]> {
  try {
    return await timeout(
      fetchMessagesFromPiChain(chainMetadata, query, multiProvider, registry, queryType),
      MESSAGE_SEARCH_TIMEOUT,
      'message search timeout',
    );
  } catch (error) {
    logger.debug('Error fetching PI messages for chain:', chainMetadata.name, error);
    throw error;
  }
}
