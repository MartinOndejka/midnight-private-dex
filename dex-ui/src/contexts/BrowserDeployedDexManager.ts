// This file is part of midnightntwrk/example-bboard.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { PdexAPI, type PdexCircuitKeys, type PdexProviders, type DeployedPdexAPI } from '../../../api/src/index';
import { type ContractAddress, fromHex, toHex } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  BehaviorSubject,
  catchError,
  concatMap,
  filter,
  firstValueFrom,
  interval,
  map,
  type Observable,
  take,
  tap,
  throwError,
  timeout,
} from 'rxjs';
import { pipe as fnPipe } from 'fp-ts/function';
import { type Logger } from 'pino';
import { ConnectedAPI, type InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import semver from 'semver';
import {
  Binding,
  FinalizedTransaction,
  Proof,
  SignatureEnabled,
  Transaction,
  TransactionId,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { PdexPrivateState } from '@midnight-ntwrk/pdex-contract';
import { inMemoryPrivateStateProvider } from '../in-memory-private-state-provider';
import { withLocalStorageSecretKey } from '../local-storage-secret-key';
import { NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';

/**
 * An in-progress DEX deployment.
 */
export interface InProgressDexDeployment {
  readonly status: 'in-progress';
}

/**
 * A deployed DEX deployment.
 */
export interface DeployedDexDeployment {
  readonly status: 'deployed';

  /**
   * The {@link DeployedPdexAPI} instance when connected to an on network DEX contract.
   */
  readonly api: DeployedPdexAPI;
}

/**
 * A failed DEX deployment.
 */
export interface FailedDexDeployment {
  readonly status: 'failed';

  /**
   * The error that caused the deployment to fail.
   */
  readonly error: Error;
}

/**
 * A DEX deployment.
 */
export type DexDeployment = InProgressDexDeployment | DeployedDexDeployment | FailedDexDeployment;

/**
 * Provides access to DEX deployments.
 */
export interface DeployedDexAPIProvider {
  /**
   * Gets the observable set of board deployments.
   *
   * @remarks
   * This property represents an observable array of {@link DexDeployment}, each also an
   * observable. Changes to the array will be emitted as boards are resolved (deployed or joined),
   * while changes to each underlying board can be observed via each item in the array.
   */
  readonly dexDeployments$: Observable<Array<Observable<DexDeployment>>>;

  /**
   * Joins or deploys a DEX contract.
   *
   * @param contractAddress An optional contract address to use when resolving.
   * @returns An observable board deployment.
   *
   * @remarks
   * For a given `contractAddress`, the method will attempt to find and join the identified DEX
   * contract; otherwise it will attempt to deploy a new one.
   */
  readonly resolve: (contractAddress?: ContractAddress) => Observable<DexDeployment>;

  /**
   * Gets the shielded balances of the connected wallet, keyed by raw token type.
   */
  readonly shieldedBalances: () => Promise<Record<string, bigint>>;
}

/**
 * A {@link DeployedDexAPIProvider} that manages DEX deployments in a browser setting.
 *
 * @remarks
 * {@link BrowserDeployedDexManager} configures and manages a connection to the Midnight Lace
 * wallet, along with a collection of additional providers that work in a web-browser setting.
 */
export class BrowserDeployedDexManager implements DeployedDexAPIProvider {
  readonly #dexDeploymentsSubject: BehaviorSubject<Array<BehaviorSubject<DexDeployment>>>;
  #initializedProviders: Promise<InitializedProviders> | undefined;

  /**
   * Initializes a new {@link BrowserDeployedDexManager} instance.
   *
   * @param logger The `pino` logger to for logging.
   */
  constructor(private readonly logger: Logger) {
    this.#dexDeploymentsSubject = new BehaviorSubject<Array<BehaviorSubject<DexDeployment>>>([]);
    this.dexDeployments$ = this.#dexDeploymentsSubject;
  }

  /** @inheritdoc */
  readonly dexDeployments$: Observable<Array<Observable<DexDeployment>>>;

  /** @inheritdoc */
  resolve(contractAddress?: ContractAddress): Observable<DexDeployment> {
    const deployments = this.#dexDeploymentsSubject.value;
    let deployment = deployments.find(
      (deployment) =>
        deployment.value.status === 'deployed' && deployment.value.api.deployedContractAddress === contractAddress,
    );

    if (deployment) {
      return deployment;
    }

    deployment = new BehaviorSubject<DexDeployment>({
      status: 'in-progress',
    });

    if (contractAddress) {
      void this.joinDeployment(deployment, contractAddress);
    } else {
      void this.deployDeployment(deployment);
    }

    this.#dexDeploymentsSubject.next([...deployments, deployment]);

    return deployment;
  }

  /** @inheritdoc */
  async shieldedBalances(): Promise<Record<string, bigint>> {
    const { connectedAPI } = await this.getInitialized();
    return connectedAPI.getShieldedBalances();
  }

  private async getProviders(): Promise<PdexProviders> {
    return (await this.getInitialized()).providers;
  }

  private getInitialized(): Promise<InitializedProviders> {
    // We use a cached `Promise` to hold the providers. This will:
    //
    // 1. Cache and re-use the providers (including the configured connector API), and
    // 2. Act as a synchronization point if multiple contract deploys or joins run concurrently.
    //    Concurrent calls to `getProviders()` will receive, and ultimately await, the same
    //    `Promise`.
    return this.#initializedProviders ?? (this.#initializedProviders = initializeProviders(this.logger));
  }

  private async deployDeployment(deployment: BehaviorSubject<DexDeployment>): Promise<void> {
    try {
      const providers = await this.getProviders();
      const api = await PdexAPI.deploy(providers, this.logger);

      deployment.next({
        status: 'deployed',
        api,
      });
    } catch (error: unknown) {
      deployment.next({
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async joinDeployment(
    deployment: BehaviorSubject<DexDeployment>,
    contractAddress: ContractAddress,
  ): Promise<void> {
    try {
      const providers = await this.getProviders();
      const api = await PdexAPI.join(providers, contractAddress, this.logger);

      deployment.next({
        status: 'deployed',
        api,
      });
    } catch (error: unknown) {
      deployment.next({
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

type InitializedProviders = { providers: PdexProviders; connectedAPI: ConnectedAPI };

/** @internal */
const initializeProviders = async (logger: Logger): Promise<InitializedProviders> => {
  const networkId = import.meta.env.VITE_NETWORK_ID as NetworkId;
  const connectedAPI = await connectToWallet(logger, networkId);
  const zkConfigPath = window.location.origin; // '../../../contract/src/managed/pdex';
  const keyMaterialProvider = new FetchZkConfigProvider<PdexCircuitKeys>(zkConfigPath, fetch.bind(window));
  const config = await connectedAPI.getConfiguration();
  const shieldedAddresses = await connectedAPI.getShieldedAddresses();
  // The secret key that owns the user's orders must survive a page reload, so we keep it in local storage.
  const privateStateProvider = withLocalStorageSecretKey(
    inMemoryPrivateStateProvider<string, PdexPrivateState>(),
    shieldedAddresses.shieldedCoinPublicKey,
  );
  const providers: PdexProviders = {
    privateStateProvider,
    zkConfigProvider: keyMaterialProvider,
    proofProvider: httpClientProofProvider(config.proverServerUri!, keyMaterialProvider),
    publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
    walletProvider: {
      getCoinPublicKey(): string {
        return shieldedAddresses.shieldedCoinPublicKey;
      },
      getEncryptionPublicKey(): string {
        return shieldedAddresses.shieldedEncryptionPublicKey;
      },
      balanceTx: async (tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> => {
        try {
          logger.info({ tx, ttl }, 'Balancing transaction via wallet');
          const serializedTx = toHex(tx.serialize());
          const received = await connectedAPI.balanceUnsealedTransaction(serializedTx);
          return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
            'signature',
            'proof',
            'binding',
            fromHex(received.tx),
          );
        } catch (e) {
          logger.error({ error: e }, 'Error balancing transaction via wallet');
          throw e;
        }
      },
    },
    midnightProvider: {
      submitTx: async (tx: FinalizedTransaction): Promise<TransactionId> => {
        await connectedAPI.submitTransaction(toHex(tx.serialize()));
        const txIdentifiers = tx.identifiers();
        const txId = txIdentifiers[0]; // Return the first transaction ID
        logger.info({ txIdentifiers }, 'Submitted transaction via wallet');
        return txId;
      },
    },
  };
  return { providers, connectedAPI };
};

/** @internal */
const getFirstCompatibleWallet = (): InitialAPI | undefined => {
  if (!window.midnight) return undefined;
  return Object.values(window.midnight).find(
    (wallet): wallet is InitialAPI =>
      !!wallet &&
      typeof wallet === 'object' &&
      'apiVersion' in wallet &&
      semver.satisfies(wallet.apiVersion, COMPATIBLE_CONNECTOR_API_VERSION),
  );
};

const COMPATIBLE_CONNECTOR_API_VERSION = '4.x';

/** @internal */
const connectToWallet = (logger: Logger, networkId: string): Promise<ConnectedAPI> => {
  return firstValueFrom(
    fnPipe(
      interval(100),
      map(() => getFirstCompatibleWallet()),
      tap((connectorAPI) => {
        logger.info(connectorAPI, 'Check for wallet connector API');
      }),
      filter((connectorAPI): connectorAPI is InitialAPI => !!connectorAPI),
      tap((connectorAPI) => {
        logger.info(connectorAPI, 'Compatible wallet connector API found. Connecting.');
      }),
      take(1),
      timeout({
        first: 1_000,
        with: () =>
          throwError(() => {
            logger.error('Could not find wallet connector API');

            return new Error('Could not find Midnight Lace wallet. Extension installed?');
          }),
      }),
      concatMap(async (initialAPI) => {
        const connectedAPI = await initialAPI.connect(networkId);
        const connectionStatus = await connectedAPI.getConnectionStatus();
        logger.info(connectionStatus, 'Wallet connector API enabled status');
        return connectedAPI;
      }),
      timeout({
        first: 5_000,
        with: () =>
          throwError(() => {
            logger.error('Wallet connector API has failed to respond');

            return new Error('Midnight Lace wallet has failed to respond. Extension enabled?');
          }),
      }),
      catchError((error, apis) =>
        error
          ? throwError(() => {
              logger.error('Unable to enable connector API' + error);
              return new Error('Application is not authorized');
            })
          : apis,
      ),
    ),
  );
};
