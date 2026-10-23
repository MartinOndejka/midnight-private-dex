// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

import {
  type CircuitContext,
  createConstructorContext,
  createCircuitContext,
  emptyZswapLocalState,
  sampleContractAddress,
  decodeZswapLocalState,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
  Side,
} from "../managed/pdex/contract/index.js";
import { type PdexPrivateState, witnesses } from "../witnesses.js";
import { pdexTokenColors } from "../index.js";
import { randomBytes } from "./utils.js";

export type Coin = { nonce: Uint8Array; color: Uint8Array; value: bigint };

/** One user of the DEX: a secret key for order ownership and a coin key. */
export type User = { secretKey: Uint8Array; coinPublicKey: string };

export const newUser = (): User => ({
  secretKey: randomBytes(32),
  coinPublicKey: Buffer.from(randomBytes(32)).toString("hex"),
});

/**
 * Runs the DEX circuits in memory. It does not make proofs or real Zswap
 * transactions, but it checks all contract rules and ledger updates.
 */
export class PdexSimulator {
  readonly contract = new Contract<PdexPrivateState>(witnesses);
  readonly address = sampleContractAddress();
  readonly colors = pdexTokenColors(this.address);
  circuitContext: CircuitContext<PdexPrivateState>;

  constructor(user: User) {
    const { currentPrivateState, currentContractState } =
      this.contract.initialState(
        createConstructorContext(
          { secretKey: user.secretKey },
          user.coinPublicKey,
        ),
      );
    this.circuitContext = createCircuitContext(
      this.address,
      user.coinPublicKey,
      currentContractState,
      currentPrivateState,
    );
  }

  /** Make `user` the caller of the next circuits. */
  as(user: User): this {
    this.circuitContext = {
      ...this.circuitContext,
      currentPrivateState: { secretKey: user.secretKey },
      currentZswapLocalState: emptyZswapLocalState(user.coinPublicKey),
    };
    return this;
  }

  getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  /** Coins that the last circuit sent to the caller. */
  outputs() {
    return decodeZswapLocalState(this.circuitContext.currentZswapLocalState)
      .outputs;
  }

  coin(isBase: boolean, value: bigint): Coin {
    return {
      nonce: randomBytes(32),
      color: isBase ? this.colors.base : this.colors.quote,
      value,
    };
  }

  faucet(isBase: boolean, amount: bigint): Coin {
    const r = this.contract.impureCircuits.faucet(
      this.circuitContext,
      isBase,
      amount,
    );
    this.circuitContext = r.context;
    return r.result;
  }

  placeOrder(
    side: Side,
    price: bigint,
    size: bigint,
    coin: Coin,
    minFill = 1n,
  ): bigint {
    const r = this.contract.impureCircuits.placeOrder(
      this.circuitContext,
      side,
      price,
      size,
      minFill,
      coin,
    );
    this.circuitContext = r.context;
    return r.result;
  }

  fillOrder(orderId: bigint, amount: bigint, payment: Coin): void {
    this.circuitContext = this.contract.impureCircuits.fillOrder(
      this.circuitContext,
      orderId,
      amount,
      payment,
    ).context;
  }

  claim(orderId: bigint): void {
    this.circuitContext = this.contract.impureCircuits.claim(
      this.circuitContext,
      orderId,
    ).context;
  }

  cancelOrder(orderId: bigint): void {
    this.circuitContext = this.contract.impureCircuits.cancelOrder(
      this.circuitContext,
      orderId,
    ).context;
  }
}
