import { isAddress } from '@hyperlane-xyz/utils';

import { MessageStatusFilter } from '../../../types';
import { adjustToUtcTime } from '../../../utils/time';
import { isPotentiallyTransactionHash, searchValueToPostgresBytea } from './encoding';
import { messageDetailsFragment, messageStubFragment } from './fragments';

/**
 * ========================
 * QUERY ASSEMBLY UTILITIES
 * For building queries
 * ========================
 */

// The list of valid query params to find messages
export enum MessageIdentifierType {
  Id = 'id', // Note: message id, not database id
  Sender = 'sender',
  Recipient = 'recipient',
  OriginTxHash = 'origin-tx-hash',
  OriginTxSender = 'origin-tx-sender',
  DestinationTxHash = 'destination-tx-hash',
  DestinationTxSender = 'destination-tx-sender',
}

export function buildMessageQuery(
  idType: MessageIdentifierType,
  idValue: string,
  limit: number,
  useStub = false,
  orderBy?: string,
) {
  let whereClause: string;
  if (idType === MessageIdentifierType.Id) {
    whereClause = 'msg_id: {_eq: $identifier}';
  } else if (idType === MessageIdentifierType.Sender) {
    whereClause = 'sender: {_eq: $identifier}';
  } else if (idType === MessageIdentifierType.Recipient) {
    whereClause = 'recipient: {_eq: $identifier}';
  } else if (idType === MessageIdentifierType.OriginTxHash) {
    whereClause = 'origin_tx_hash: {_eq: $identifier}';
  } else if (idType === MessageIdentifierType.OriginTxSender) {
    whereClause = 'origin_tx_sender: {_eq: $identifier}';
  } else if (idType === MessageIdentifierType.DestinationTxHash) {
    whereClause = 'destination_tx_hash: {_eq: $identifier}';
  } else if (idType === MessageIdentifierType.DestinationTxSender) {
    whereClause = 'destination_tx_sender: {_eq: $identifier}';
  } else {
    throw new Error(`Invalid id type: ${idType}`);
  }
  const variables = { identifier: searchValueToPostgresBytea(idValue) };

  const query = `
  query ($identifier: bytea!) @cached(ttl: 5) {
    message_view(
      where: {${whereClause}},
      ${orderBy ? `order_by: {${orderBy}},` : ''}
      limit: ${limit}
    ) {
      ${useStub ? messageStubFragment : messageDetailsFragment}
    }
  }
  `;
  return { query, variables };
}

export function buildMessageSearchQuery(
  searchInput: string,
  originDomainIdFilter: number | null,
  destDomainIdFilter: number | null,
  startTimeFilter: number | null,
  endTimeFilter: number | null,
  limit: number,
  useStub = false,
  mainnetDomainIds?: number[],
  statusFilter: MessageStatusFilter = 'all',
  warpRouteAddresses: string[] = [],
  isPendingFilter = false,
  // Domain ids of the Terra Classic chains. This explorer only surfaces TC-involved messages,
  // so when one side is filtered to a non-TC chain the OTHER side must be constrained to TC at
  // the DB level — otherwise the limited result window is dominated by unrelated traffic (e.g.
  // recent Ethereum-origin messages all go to Base/Arbitrum) and the client-side TC filter in
  // MessageSearch.tsx empties everything.
  tcDomainIds: number[] = [],
) {
  const originChains = originDomainIdFilter ? [originDomainIdFilter] : undefined;
  const destinationChains = destDomainIdFilter ? [destDomainIdFilter] : undefined;
  const startTime = startTimeFilter ? adjustToUtcTime(startTimeFilter) : undefined;
  const endTime = endTimeFilter ? adjustToUtcTime(endTimeFilter) : undefined;

  // Convert warp route addresses to bytea format, filtering out any invalid addresses
  const warpAddressesBytea = warpRouteAddresses
    .map((addr) => searchValueToPostgresBytea(addr))
    .filter((addr): addr is string => !!addr);

  const hasTc = tcDomainIds.length > 0;
  const originIsTc = originDomainIdFilter != null && tcDomainIds.includes(originDomainIdFilter);
  const destIsTc = destDomainIdFilter != null && tcDomainIds.includes(destDomainIdFilter);

  const hasFilters = !!(
    originDomainIdFilter ||
    destDomainIdFilter ||
    startTimeFilter ||
    endTimeFilter ||
    searchInput ||
    statusFilter !== 'all' ||
    warpAddressesBytea.length > 0 ||
    isPendingFilter
  );

  // Decide where the $tcChains variable is needed. The explorer only surfaces TC-involved
  // messages, so constrain the unpinned side to TC when the opposite side is a non-TC chain,
  // or require TC involvement when nothing is pinned but other filters are active.
  // Each "constrain X to TC" only fires when X itself is unpinned — buildDomainIdWhereClause
  // ignores the TC fallback once a side has an explicit domain filter, so emitting $tcChains
  // when both sides are pinned would declare a variable the query never uses (Hasura rejects it).
  const constrainOriginToTc =
    hasTc && !originDomainIdFilter && !!destDomainIdFilter && !destIsTc;
  const constrainDestToTc = hasTc && !destDomainIdFilter && !!originDomainIdFilter && !originIsTc;
  const requireTcInvolvement = hasTc && !originDomainIdFilter && !destDomainIdFilter && hasFilters;
  // Hasura rejects passing a variable value that the query body never references
  // ("unexpected variables in variableValues"), so only declare/provide $tcChains when used.
  const usesTcChains = constrainOriginToTc || constrainDestToTc || requireTcInvolvement;

  const variables: Record<string, unknown> = {
    search: searchValueToPostgresBytea(searchInput),
    originChains,
    destinationChains,
    startTime,
    endTime,
  };

  // Only add warpAddresses to variables if there are valid addresses to filter
  if (warpAddressesBytea.length > 0) {
    variables.warpAddresses = warpAddressesBytea;
  }

  if (usesTcChains) {
    variables.tcChains = tcDomainIds;
  }

  const whereClauses = buildSearchWhereClauses(searchInput);
  const originDomainWhereClause = buildDomainIdWhereClause(
    originDomainIdFilter,
    hasFilters,
    'origin',
    mainnetDomainIds,
    constrainOriginToTc,
  );
  const destinationDomainWhereClause = buildDomainIdWhereClause(
    destDomainIdFilter,
    hasFilters,
    'destination',
    mainnetDomainIds,
    constrainDestToTc,
  );

  const tcInvolvementClause = requireTcInvolvement
    ? '{_or: [{origin_domain_id: {_in: $tcChains}}, {destination_domain_id: {_in: $tcChains}}]},'
    : '';

  // Build status filter clause
  const statusWhereClause = buildStatusWhereClause(statusFilter);

  // Build warp route address filter clause
  const warpRouteWhereClause = buildWarpRouteWhereClause(warpAddressesBytea);

  // Due to DB performance issues, we cannot use an `_or` clause
  // Instead, each where clause for the search will be its own query
  const queries = whereClauses.map(
    (whereClause, i) =>
      `q${i}: message_view(
    where: {
      _and: [
        ${originDomainWhereClause}
        ${destinationDomainWhereClause}
        ${tcInvolvementClause}
        ${startTimeFilter ? '{send_occurred_at: {_gte: $startTime}},' : ''}
        ${endTimeFilter ? '{send_occurred_at: {_lte: $endTime}},' : ''}
        ${statusWhereClause}
        ${warpRouteWhereClause}
        ${whereClause}
      ]
    },
    order_by: {id: desc},
    limit: ${limit}
    ) {
      ${useStub ? messageStubFragment : messageDetailsFragment}
    }`,
  );

  // Build the variable declarations for the query
  const variableDeclarations = [
    '$search: bytea',
    '$originChains: [Int!]',
    '$destinationChains: [Int!]',
    '$startTime: timestamp',
    '$endTime: timestamp',
  ];
  if (warpAddressesBytea.length > 0) {
    variableDeclarations.push('$warpAddresses: [bytea!]');
  }
  if (usesTcChains) {
    variableDeclarations.push('$tcChains: [Int!]');
  }

  const query = `query (${variableDeclarations.join(', ')}) @cached(ttl: 5) {
    ${queries.join('\n')}
  }`;
  return { query, variables };
}

// Note: Only 'delivered' filter is applied at DB level. 'pending' uses client-side
// filtering (see useMessageQuery.ts) because DB query for is_delivered=false is slow.
function buildStatusWhereClause(statusFilter: MessageStatusFilter): string {
  if (statusFilter === 'delivered') {
    return '{is_delivered: {_eq: true}},';
  }
  return '';
}

function buildWarpRouteWhereClause(warpAddressesBytea: string[]): string {
  if (warpAddressesBytea.length === 0) return '';
  // Filter messages where sender OR recipient is in the warp route addresses
  return '{_or: [{sender: {_in: $warpAddresses}}, {recipient: {_in: $warpAddresses}}]},';
}

function buildSearchWhereClauses(searchInput: string) {
  if (!searchInput) return [''];

  const clauses: string[] = [];
  if (isAddress(searchInput)) {
    clauses.push(
      `{sender: {_eq: $search}}`,
      `{recipient: {_eq: $search}}`,
      `{origin_tx_sender: {_eq: $search}}`,
      `{destination_tx_sender: {_eq: $search}}`,
    );
  }
  if (isPotentiallyTransactionHash(searchInput)) {
    clauses.push(`{origin_tx_hash: {_eq: $search}}`, `{destination_tx_hash: {_eq: $search}}`);
  }
  clauses.push(`{msg_id: {_eq: $search}}`);

  return clauses;
}

function buildDomainIdWhereClause(
  domainId: number | null,
  hasFilters: boolean,
  fieldName: 'origin' | 'destination',
  mainnetDomainIds: number[] = [],
  // When true, constrain this side to the Terra Classic domains via the $tcChains variable.
  // Used when the opposite side is pinned to a non-TC chain so only TC routes are returned.
  constrainToTc = false,
) {
  // if the domainId is set, filter by this domainId instead of mainnet domains
  if (domainId) return `{${fieldName}_domain_id: {_in: $${fieldName}Chains}},`;

  // opposite side pinned to a non-TC chain: this side must be a TC domain
  if (constrainToTc) return `{${fieldName}_domain_id: {_in: $tcChains}},`;

  // if no filters are set, filter by mainnet chains to not display testnest messages for vanilla query
  if (!hasFilters) return `{${fieldName}_domain_id: {_in: [${mainnetDomainIds}]}},`;

  // if domainId is not set but there are other filters, remove condition of filtering by mainnet chains
  return '';
}
