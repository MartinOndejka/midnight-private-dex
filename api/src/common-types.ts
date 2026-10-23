// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

/**
 * DEX common types and abstractions.
 *
 * @module
 */

import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { type FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { PdexPrivateState, Contract, Witnesses, Side, PdexTokens } from '../../contract/src/index';

export const pdexPrivateStateKey = 'pdexPrivateState';
export type PrivateStateId = typeof pdexPrivateStateKey;

/**
 * The private states consumed throughout the application.
 *
 * @public
 */
export type PrivateStates = {
  /**
   * Key used to provide the private state for {@link PdexContract} deployments.
   */
  readonly pdexPrivateState: PdexPrivateState;
};

/**
 * Represents a DEX contract and its private state.
 *
 * @public
 */
export type PdexContract = Contract<PdexPrivateState, Witnesses<PdexPrivateState>>;

/**
 * The keys of the circuits exported from {@link PdexContract}.
 *
 * @public
 */
export type PdexCircuitKeys = Exclude<keyof PdexContract['impureCircuits'], number | symbol>;

/**
 * The providers required by {@link PdexContract}.
 *
 * @public
 */
export type PdexProviders = MidnightProviders<PdexCircuitKeys, PrivateStateId, PdexPrivateState>;

/**
 * A {@link PdexContract} that has been deployed to the network.
 *
 * @public
 */
export type DeployedPdexContract = FoundContract<PdexContract>;

/**
 * One order on the book, as the current user sees it.
 */
export type OrderView = {
  readonly id: bigint;
  readonly side: Side;
  /** QUOTE units for one BASE unit. */
  readonly price: bigint;
  readonly size: bigint;
  readonly remaining: bigint;
  /** Smallest fill in BASE units, except a fill of all of `remaining`. */
  readonly minFill: bigint;
  /** Proceeds that the maker did not claim yet (QUOTE for SELL, BASE for BUY). */
  readonly unclaimed: bigint;

  /**
   * `true` if the secret key of the current user opens the owner commitment of this order.
   *
   * @remarks
   * Only the maker can compute this. Other users see an opaque commitment that is different for
   * each order.
   */
  readonly isMine: boolean;
};

/**
 * A type that represents the derived combination of public (or ledger), and private state.
 */
export type PdexDerivedState = {
  readonly tokens: PdexTokens;
  /** SELL orders, lowest price first. */
  readonly asks: readonly OrderView[];
  /** BUY orders, highest price first. */
  readonly bids: readonly OrderView[];
};
