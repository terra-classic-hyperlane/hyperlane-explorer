import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useMultiProviderVersion, useReadyMultiProvider, useRegistry } from '../../store';
import type { Message, MessageStub } from '../../types';
import { fetchIgpGasPaymentsFromRegistry } from './pi-queries/fetchPiChainMessages';

/**
 * Supplements gas data for EVM-origin messages where the registry IGP differs
 * from the official Hyperlane IGP indexed by the Hasura DB (so Hasura shows 0).
 */
export function useSupplementalIgpData(message: Message | MessageStub | undefined) {
  const multiProvider = useReadyMultiProvider();
  const multiProviderVersion = useMultiProviderVersion();
  const registry = useRegistry();

  const needsSupplement = useMemo(() => {
    if (!message || !multiProvider) return false;
    // Only supplement when gas data is zero
    if ('numPayments' in message && (message.numPayments ?? 0) > 0) return false;
    const protocol = multiProvider.tryGetChainMetadata(message.originDomainId)?.protocol;
    return protocol === 'ethereum';
  }, [message, multiProvider]);

  const { data } = useQuery({
    queryKey: ['supplementalIgp', message?.msgId, multiProviderVersion],
    queryFn: async () => {
      if (!message || !multiProvider || !needsSupplement) return null;
      return fetchIgpGasPaymentsFromRegistry(message as Message, multiProvider, registry);
    },
    enabled: needsSupplement && !!multiProvider,
    staleTime: 60_000,
    retry: false,
  });

  return data ?? null;
}
