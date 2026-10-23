// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provides types and utilities for working with the private order book DEX contract.
 *
 * @packageDocumentation
 */

import * as Pdex from '../../contract/src/managed/pdex/contract/index.js';

import { type ContractAddress, encodeContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { type Logger } from 'pino';
import {
  type OrderView,
  type PdexDerivedState,
  type PdexContract,
  type PdexProviders,
  type DeployedPdexContract,
  pdexPrivateStateKey,
} from './common-types.js';
import { CompiledPdexContract, pdexTokenColors, pdexTokens, type PdexTokens } from '../../contract/src/index';
import * as utils from './utils/index.js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { combineLatest, map, from, type Observable } from 'rxjs';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { type PdexPrivateState, createPdexPrivateState } from '../../contract/src/witnesses.js';

export { Side } from '../../contract/src/managed/pdex/contract/index.js';
export type { PdexTokens } from '../../contract/src/index';

/**
 * An API for a deployed DEX.
 */
export interface DeployedPdexAPI {
  readonly deployedContractAddress: ContractAddress;
  readonly tokens: PdexTokens;
  readonly state$: Observable<PdexDerivedState>;

  faucet: (token: 'base' | 'quote', amount: bigint) => Promise<void>;
  placeOrder: (side: Pdex.Side, price: bigint, size: bigint, minFill?: bigint) => Promise<bigint>;
  fillOrder: (orderId: bigint, amount: bigint) => Promise<void>;
  claim: (orderId: bigint) => Promise<void>;
  cancelOrder: (orderId: bigint) => Promise<void>;
}

/**
 * Derives the order book that the current user sees from the ledger state and the user's secret key.
 */
export const deriveState = (
  contractAddress: ContractAddress,
  ledgerState: Pdex.Ledger,
  secretKey: Uint8Array,
  tokens: PdexTokens,
): PdexDerivedState => {
  const dex = encodeContractAddress(contractAddress);
  const orders: OrderView[] = [];
  for (const [id, order] of ledgerState.orders) {
    orders.push({
      id,
      side: order.side,
      price: order.price,
      size: order.size,
      remaining: order.remaining,
      minFill: order.minFill,
      unclaimed: ledgerState.proceeds.member(id) ? ledgerState.proceeds.lookup(id).value : 0n,
      isMine: toHex(Pdex.pureCircuits.ownerCommitment(dex, id, secretKey)) === toHex(order.owner),
    });
  }
  const byPrice = (a: OrderView, b: OrderView) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0);
  const open = (o: OrderView) => o.remaining > 0n;
  return {
    tokens,
    asks: orders.filter((o) => o.side === Pdex.Side.SELL && (open(o) || o.isMine)).sort(byPrice),
    bids: orders.filter((o) => o.side === Pdex.Side.BUY && (open(o) || o.isMine)).sort((a, b) => byPrice(b, a)),
  };
};

/**
 * Provides an implementation of {@link DeployedPdexAPI} by adapting a deployed DEX contract.
 *
 * @remarks
 * The `PdexPrivateState` is managed at the DApp level by a private state provider. It holds a
 * `'secretKey'` that the contract hashes with each order id into an owner commitment. The secret key
 * never leaves the user's machine; only the commitment is on the ledger.
 */
export class PdexAPI implements DeployedPdexAPI {
  /** @internal */
  private constructor(
    public readonly deployedContract: DeployedPdexContract,
    private readonly providers: PdexProviders,
    private readonly logger?: Logger,
  ) {
    this.deployedContractAddress = deployedContract.deployTxData.public.contractAddress;
    this.tokens = pdexTokens(this.deployedContractAddress);
    this.colors = pdexTokenColors(this.deployedContractAddress);
    providers.privateStateProvider.setContractAddress(this.deployedContractAddress);
    this.state$ = combineLatest(
      [
        providers.publicDataProvider
          .contractStateObservable(this.deployedContractAddress, { type: 'latest' })
          .pipe(map((contractState) => Pdex.ledger(contractState.data))),
        // The private state of the DEX never changes, so we query it once.
        from(providers.privateStateProvider.get(pdexPrivateStateKey) as Promise<PdexPrivateState>),
      ],
      (ledgerState, privateState) =>
        deriveState(this.deployedContractAddress, ledgerState, privateState.secretKey, this.tokens),
    );
  }

  /**
   * Gets the address of the current deployed contract.
   */
  readonly deployedContractAddress: ContractAddress;

  /**
   * Gets the token types of the BASE / QUOTE pair that this DEX mints and trades.
   */
  readonly tokens: PdexTokens;

  private readonly colors: { base: Uint8Array; quote: Uint8Array };

  /**
   * Gets an observable stream of the order book, as the current user sees it.
   */
  readonly state$: Observable<PdexDerivedState>;

  /**
   * Makes a new shielded coin description for a circuit argument. The wallet funds it from the user's
   * own coins when it balances the transaction.
   */
  private coin(token: 'base' | 'quote', value: bigint) {
    return { nonce: utils.randomBytes(32), color: this.colors[token], value };
  }

  private trace(circuit: string, txData: { public: { txHash: string; blockHeight: number } }) {
    this.logger?.trace({
      transactionAdded: { circuit, txHash: txData.public.txHash, blockHeight: txData.public.blockHeight },
    });
  }

  /**
   * Mints test tokens to the user's shielded wallet.
   */
  async faucet(token: 'base' | 'quote', amount: bigint): Promise<void> {
    this.logger?.info({ faucet: { token, amount } });
    this.trace('faucet', await this.deployedContract.callTx.faucet(token === 'base', amount));
  }

  /**
   * Places a limit order and locks its escrow in the contract.
   *
   * @param side BUY or SELL BASE.
   * @param price QUOTE units for one BASE unit.
   * @param size BASE units.
   * @param minFill Smallest fill in BASE units, except a fill of all that remains. A larger value makes it
   * harder for takers to block a cancel with many small fills.
   * @returns The id of the new order.
   */
  async placeOrder(side: Pdex.Side, price: bigint, size: bigint, minFill = 1n): Promise<bigint> {
    this.logger?.info({ placeOrder: { side: Pdex.Side[side], price, size, minFill } });
    const escrow = side === Pdex.Side.SELL ? this.coin('base', size) : this.coin('quote', size * price);
    const txData = await this.deployedContract.callTx.placeOrder(side, price, size, minFill, escrow);
    this.trace('placeOrder', txData);
    return txData.private.result;
  }

  /**
   * Fills `amount` BASE units of an order on the book.
   *
   * @remarks
   * This method reads the order price from the latest ledger state. It can fail during local circuit
   * execution if the order is gone, or if `amount` is more than the remaining size.
   */
  async fillOrder(orderId: bigint, amount: bigint): Promise<void> {
    const order = await this.readOrder(orderId);
    this.logger?.info({ fillOrder: { orderId, amount, side: Pdex.Side[order.side], price: order.price } });
    const payment =
      order.side === Pdex.Side.SELL ? this.coin('quote', amount * order.price) : this.coin('base', amount);
    this.trace('fillOrder', await this.deployedContract.callTx.fillOrder(orderId, amount, payment));
  }

  /**
   * Sends the unclaimed proceeds of one of the user's orders to the user's wallet.
   */
  async claim(orderId: bigint): Promise<void> {
    this.logger?.info({ claim: { orderId } });
    this.trace('claim', await this.deployedContract.callTx.claim(orderId));
  }

  /**
   * Cancels one of the user's orders. The remaining escrow and the unclaimed proceeds go back to the
   * user's wallet.
   */
  async cancelOrder(orderId: bigint): Promise<void> {
    this.logger?.info({ cancelOrder: { orderId } });
    this.trace('cancelOrder', await this.deployedContract.callTx.cancelOrder(orderId));
  }

  private async readOrder(orderId: bigint): Promise<Pdex.Order> {
    const contractState = await this.providers.publicDataProvider.queryContractState(this.deployedContractAddress);
    const ledgerState = contractState ? Pdex.ledger(contractState.data) : undefined;
    if (!ledgerState?.orders.member(orderId)) {
      throw new Error(`Order ${orderId} is not on the book`);
    }
    return ledgerState.orders.lookup(orderId);
  }

  /**
   * Deploys a new DEX contract to the network.
   *
   * @param providers The DEX providers.
   * @param logger An optional 'pino' logger to use for logging.
   * @returns A `Promise` that resolves with a {@link PdexAPI} instance that manages the newly deployed
   * {@link DeployedPdexContract}; or rejects with a deployment error.
   */
  static async deploy(providers: PdexProviders, logger?: Logger): Promise<PdexAPI> {
    logger?.info('deployContract');

    const deployedPdexContract = await deployContract(providers, {
      compiledContract: CompiledPdexContract,
      privateStateId: pdexPrivateStateKey,
      initialPrivateState: createPdexPrivateState(utils.randomBytes(32)),
    });

    logger?.trace({
      contractDeployed: {
        finalizedDeployTxData: deployedPdexContract.deployTxData.public,
      },
    });

    return new PdexAPI(deployedPdexContract, providers, logger);
  }

  /**
   * Finds an already deployed DEX contract on the network, and joins it.
   *
   * @param providers The DEX providers.
   * @param contractAddress The contract address of the deployed DEX contract to search for and join.
   * @param logger An optional 'pino' logger to use for logging.
   * @returns A `Promise` that resolves with a {@link PdexAPI} instance that manages the joined
   * {@link DeployedPdexContract}; or rejects with an error.
   */
  static async join(providers: PdexProviders, contractAddress: ContractAddress, logger?: Logger): Promise<PdexAPI> {
    logger?.info({
      joinContract: {
        contractAddress,
      },
    });

    const deployedPdexContract = await findDeployedContract<PdexContract>(providers, {
      contractAddress,
      compiledContract: CompiledPdexContract,
      privateStateId: pdexPrivateStateKey,
      initialPrivateState: await PdexAPI.getPrivateState(providers, contractAddress),
    });

    logger?.trace({
      contractJoined: {
        finalizedDeployTxData: deployedPdexContract.deployTxData.public,
      },
    });

    return new PdexAPI(deployedPdexContract, providers, logger);
  }

  private static async getPrivateState(
    providers: PdexProviders,
    contractAddress: ContractAddress,
  ): Promise<PdexPrivateState> {
    providers.privateStateProvider.setContractAddress(contractAddress);
    const existingPrivateState = await providers.privateStateProvider.get(pdexPrivateStateKey);
    return existingPrivateState ?? createPdexPrivateState(utils.randomBytes(32));
  }
}

/**
 * A namespace that represents the exports from the `'utils'` sub-package.
 *
 * @public
 */
export * as utils from './utils/index.js';

export * from './common-types.js';
