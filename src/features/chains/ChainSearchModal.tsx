import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import { ChainSearchMenu, Modal } from '@hyperlane-xyz/widgets';
import { useEffect, useMemo } from 'react';

import { useChainMetadataMap, useStore, useWarpRouteIdToAddressesMap } from '../../metadataStore';

// This explorer is dedicated to the Terra Classic community, so the chain picker should only
// offer chains relevant to Terra Classic: the TC chains themselves plus any chain that shares
// a warp route with a TC chain (e.g. Ethereum, BSC, Solana). Derived from the warp route data
// so it stays correct as routes are added/removed.
function useTerraClassicRelevantChains(): Record<string, ChainMetadata> {
  const chains = useChainMetadataMap();
  const warpRouteIdToAddressesMap = useWarpRouteIdToAddressesMap();
  const ensureWarpRouteData = useStore((s) => s.ensureWarpRouteData);

  useEffect(() => {
    ensureWarpRouteData().catch(() => {});
  }, [ensureWarpRouteData]);

  return useMemo(() => {
    const tcNames = Object.values(chains)
      .filter((c) => c.name?.startsWith('terraclassic'))
      .map((c) => c.name);
    const tcSet = new Set(tcNames);

    // While warp route data is still loading, show everything to avoid an unusable picker.
    if (!Object.keys(warpRouteIdToAddressesMap).length) return chains;

    const allowed = new Set<string>(tcNames);
    for (const tokens of Object.values(warpRouteIdToAddressesMap)) {
      if (tokens.some((t) => tcSet.has(t.chainName))) {
        for (const t of tokens) allowed.add(t.chainName);
      }
    }

    const filtered: Record<string, ChainMetadata> = {};
    for (const [name, meta] of Object.entries(chains)) {
      if (allowed.has(name)) filtered[name] = meta;
    }
    return filtered;
  }, [chains, warpRouteIdToAddressesMap]);
}

export function ChainSearchModal({
  isOpen,
  close,
  onClickChain,
  showAddChainMenu,
}: {
  isOpen: boolean;
  close: () => void;
  onClickChain?: (metadata: ChainMetadata) => void;
  showAddChainMenu?: boolean;
}) {
  const chains = useTerraClassicRelevantChains();
  const chainMetadataOverrides = useStore((s) => s.chainMetadataOverrides);
  const setChainMetadataOverrides = useStore((s) => s.setChainMetadataOverrides);

  const handleClickChain = (metadata: ChainMetadata) => {
    if (!onClickChain) return;
    onClickChain(metadata);
    close();
  };

  return (
    <Modal
      isOpen={isOpen}
      close={close}
      panelClassname="explorer-chain-search-modal p-4 sm:p-5 max-w-lg min-h-[40vh]"
    >
      <ChainSearchMenu
        chainMetadata={chains}
        overrideChainMetadata={chainMetadataOverrides}
        onChangeOverrideMetadata={setChainMetadataOverrides}
        onClickChain={handleClickChain}
        showAddChainButton={true}
        showAddChainMenu={showAddChainMenu}
      />
    </Modal>
  );
}
