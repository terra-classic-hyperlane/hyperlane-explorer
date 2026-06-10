import { buildMessageSearchQuery } from './build';

// TC = Terra Classic domains; 56/97/11155111 are non-TC (BSC, BSC testnet, Sepolia).
const TC_DOMAINS = [132556, 1325];
const TC_V2 = 132556;
const TC_V1 = 1325;
const ETH = 1;

function build(
  origin: number | null,
  dest: number | null,
  extra: { status?: 'all' | 'delivered' | 'pending'; search?: string } = {},
) {
  return buildMessageSearchQuery(
    extra.search ?? '',
    origin,
    dest,
    null,
    null,
    50,
    true,
    [ETH, 56],
    extra.status ?? 'all',
    [],
    false,
    TC_DOMAINS,
  );
}

describe('buildMessageSearchQuery TC filtering', () => {
  // Hasura rejects passing a variable value the operation never references
  // ("unexpected variables in variableValues"). Guard the exact invariant.
  test.each([
    ['no filters (landing)', null, null, {}],
    ['origin pinned non-TC', ETH, null, {}],
    ['dest pinned non-TC', null, ETH, {}],
    ['origin pinned TC', TC_V2, null, {}],
    ['dest pinned TC', null, TC_V1, {}],
    ['both pinned, origin non-TC + dest TC', ETH, TC_V1, {}],
    ['both pinned, both non-TC', ETH, 56, {}],
    ['both pinned TC', TC_V2, TC_V1, {}],
    ['status filter only', null, null, { status: 'delivered' as const }],
  ])('%s: declares $tcChains iff it is used', (_label, origin, dest, extra) => {
    const { query, variables } = build(origin, dest, extra);
    const declaresTcChains = query.includes('$tcChains: [Int!]');
    const usesTcChains = query.includes('_in: $tcChains');
    const passesTcChains = 'tcChains' in variables;
    // The query must declare the variable exactly when it references it...
    expect(declaresTcChains).toBe(usesTcChains);
    // ...and a value is provided exactly when the variable is declared.
    expect(passesTcChains).toBe(declaresTcChains);
  });

  test('origin pinned to a non-TC chain constrains destination to TC', () => {
    const { query, variables } = build(ETH, null);
    expect(query).toContain('destination_domain_id: {_in: $tcChains}');
    expect(variables.tcChains).toEqual(TC_DOMAINS);
  });

  test('both sides pinned does not reference $tcChains', () => {
    const { query, variables } = build(ETH, TC_V1);
    expect(query).not.toContain('$tcChains');
    expect('tcChains' in variables).toBe(false);
  });

  test('status-only filter requires TC involvement via _or', () => {
    const { query } = build(null, null, { status: 'delivered' });
    expect(query).toContain('origin_domain_id: {_in: $tcChains}');
    expect(query).toContain('destination_domain_id: {_in: $tcChains}');
  });
});
