import type { IRegistry } from '@hyperlane-xyz/registry';
import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import { ensure0x, timeout } from '@hyperlane-xyz/utils';
import { useQuery } from '@tanstack/react-query';

import { useMultiProviderVersion, useReadyMultiProvider, useRegistry } from '../../../store';
import { Message } from '../../../types';
import { logger } from '../../../utils/logger';
import { useScrapedDomains } from '../../chains/queries/useScrapedChains';
import { isEvmChain, isPiChain } from '../../chains/utils';
import type { ExplorerMultiProvider as MultiProtocolProvider } from '../../hyperlane/sdkRuntime';
import { isValidSearchQuery } from '../queries/useMessageQuery';
import { PiMessageQuery, PiQueryType, fetchMessagesFromPiChain } from './fetchPiChainMessages';
import { fetchMessagesFromPiCosmosChain } from './fetchPiCosmosChainMessages';

const MESSAGE_SEARCH_TIMEOUT = 10_000; // 10s

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
}: {
  sanitizedInput: string;
  startTimeFilter?: number | null;
  endTimeFilter?: number | null;
  piQueryType?: PiQueryType;
  pause: boolean;
  originChainFilter?: string | null;
  destinationChainFilter?: string | null;
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

      // When a chain filter selects a Cosmos PI chain but there's no search text,
      // fetch recent dispatches from that chain directly.
      const chainFilterName = originChainFilter || destinationChainFilter;
      const filteredCosmosPiChain =
        !hasInput && chainFilterName
          ? cosmosPiChains.find((c) => c.name === chainFilterName)
          : undefined;

      if (filteredCosmosPiChain) {
        logger.debug('Fetching recent Cosmos PI messages for chain:', filteredCosmosPiChain.name);
        try {
          const messages = await timeout(
            fetchMessagesFromPiCosmosChain(
              filteredCosmosPiChain,
              { input: 'recent' },
              multiProvider,
              registry,
            ),
            MESSAGE_SEARCH_TIMEOUT,
            'cosmos pi recent timeout',
          );
          return messages;
        } catch {
          return [];
        }
      }

      if (!hasInput || !isValidInput) return [];
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
