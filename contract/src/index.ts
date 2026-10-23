// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import {
  encodeRawTokenType,
  rawTokenType,
} from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";

export * from "./managed/pdex/contract/index.js";
export * from "./witnesses";

import * as CompiledPdex from "./managed/pdex/contract/index.js";
import * as Witnesses from "./witnesses";

export const CompiledPdexContract = CompiledContract.make<
  CompiledPdex.Contract<Witnesses.PdexPrivateState>
>("Pdex", CompiledPdex.Contract<Witnesses.PdexPrivateState>).pipe(
  CompiledContract.withWitnesses(Witnesses.witnesses),
  CompiledContract.withCompiledFileAssets("./managed/pdex"),
);

// Must match baseDomain() and quoteDomain() in pdex.compact.
const domain = (label: string): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(label));
  return bytes;
};
export const BASE_DOMAIN = domain("pdex:token:base");
export const QUOTE_DOMAIN = domain("pdex:token:quote");

export type PdexTokens = {
  /** Raw token type (hex), as wallets show it. */
  readonly base: string;
  readonly quote: string;
};

/** Token types of the BASE / QUOTE pair that a DEX deployment mints. */
export const pdexTokens = (contractAddress: string): PdexTokens => ({
  base: rawTokenType(BASE_DOMAIN, contractAddress),
  quote: rawTokenType(QUOTE_DOMAIN, contractAddress),
});

/** Same as `pdexTokens`, but as the `Bytes<32>` color the circuits use. */
export const pdexTokenColors = (contractAddress: string) => {
  const { base, quote } = pdexTokens(contractAddress);
  return { base: encodeRawTokenType(base), quote: encodeRawTokenType(quote) };
};
