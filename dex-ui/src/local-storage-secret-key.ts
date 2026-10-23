// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { PrivateStateId, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import type { PdexPrivateState } from '@midnight-ntwrk/pdex-contract';

/**
 * Wraps a private state provider so that the DEX secret key is also kept in `localStorage`, scoped by
 * wallet and contract address.
 *
 * @remarks
 * Without the secret key, the user cannot claim or cancel their orders. This is a sample: `localStorage`
 * is not encrypted, so anyone with access to the browser profile can read the key.
 */
export const withLocalStorageSecretKey = <PSI extends PrivateStateId>(
  inner: PrivateStateProvider<PSI, PdexPrivateState>,
  walletKey: string,
): PrivateStateProvider<PSI, PdexPrivateState> => {
  let contractAddress: ContractAddress | null = null;
  const storageKey = (stateId: PSI) => `pdex:${walletKey}:${contractAddress}:${stateId}`;

  const load = (stateId: PSI): string | null => {
    try {
      return localStorage.getItem(storageKey(stateId));
    } catch {
      return null;
    }
  };

  const save = (stateId: PSI, state: PdexPrivateState): void => {
    try {
      localStorage.setItem(storageKey(stateId), toHex(state.secretKey));
    } catch {
      // Storage can be unavailable (private window, blocked site data). The key then lives only in memory.
    }
  };

  return {
    ...inner,
    setContractAddress(address: ContractAddress): void {
      contractAddress = address;
      inner.setContractAddress(address);
    },
    async set(stateId: PSI, state: PdexPrivateState): Promise<void> {
      await inner.set(stateId, state);
      save(stateId, state);
    },
    async get(stateId: PSI): Promise<PdexPrivateState | null> {
      const state = await inner.get(stateId);
      if (state !== null) {
        return state;
      }
      const hex = load(stateId);
      if (hex === null) {
        return null;
      }
      const restored = { secretKey: fromHex(hex) };
      await inner.set(stateId, restored);
      return restored;
    },
    async remove(stateId: PSI): Promise<void> {
      await inner.remove(stateId);
      try {
        localStorage.removeItem(storageKey(stateId));
      } catch {
        // See save().
      }
    },
  };
};
