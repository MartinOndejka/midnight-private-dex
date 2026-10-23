// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

/*
 * The only private state of the DEX is the user's secret key. The contract
 * hashes it with the order id to make an owner commitment for each order, so
 * the same key can own many orders that cannot be linked.
 */

import { Ledger } from "./managed/pdex/contract/index.js";
import { WitnessContext } from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";

export type PdexPrivateState = {
  readonly secretKey: Uint8Array;
};

/**
 * @param secretKey 32 random bytes, for example from `crypto.getRandomValues`. Do not use this key for
 * anything else: anyone who learns it can claim and cancel the user's orders.
 */
export const createPdexPrivateState = (
  secretKey: Uint8Array,
): PdexPrivateState => {
  if (secretKey.length !== 32) {
    throw new Error("The DEX secret key must be 32 bytes");
  }
  return { secretKey };
};

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, PdexPrivateState>): [
    PdexPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secretKey],
};
