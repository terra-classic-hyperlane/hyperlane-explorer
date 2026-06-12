import { useEffect } from 'react';

import { MessageStatusFilter } from '../../types';
import { usePiChainMessageSearchQuery } from './pi-queries/usePiChainMessageQuery';
import { PiMessageSearchState } from './piSearchState';

export function PiMessageSearchBridge({
  endTimeFilter,
  onStateChange,
  sanitizedInput,
  startTimeFilter,
  originChainFilter,
  destinationChainFilter,
  statusFilter,
}: {
  endTimeFilter: number | null;
  onStateChange: (state: PiMessageSearchState) => void;
  sanitizedInput: string;
  startTimeFilter: number | null;
  originChainFilter?: string | null;
  destinationChainFilter?: string | null;
  statusFilter?: MessageStatusFilter;
}) {
  const { hasRun, isError, isFetching, isMessagesFound, messageList } =
    usePiChainMessageSearchQuery({
      sanitizedInput,
      startTimeFilter,
      endTimeFilter,
      pause: false,
      originChainFilter,
      destinationChainFilter,
      statusFilter,
    });

  useEffect(() => {
    onStateChange({
      hasRun,
      isError,
      isFetching,
      isMessagesFound,
      messageList,
    });
  }, [hasRun, isError, isFetching, isMessagesFound, messageList, onStateChange]);

  return null;
}
