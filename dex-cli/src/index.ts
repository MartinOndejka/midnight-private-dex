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

/*
 * This file is the main driver for the private order book DEX CLI.
 * The entry point is the run function, at the end of the file.
 * We expect the launcher files (preview.ts, standalone.ts, etc.) to
 * call run with some specific configuration that sets the network addresses
 * of the servers this file relies on.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import {
  PdexAPI,
  type PdexDerivedState,
  type OrderView,
  pdexPrivateStateKey,
  type PdexProviders,
  type PdexCircuitKeys,
  type PrivateStateId,
  Side,
} from '../../api/src/index';
import { type WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { type Logger } from 'pino';
import { type Config, StandaloneConfig } from './config.js';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { type EnvironmentConfiguration, TestEnvironment } from '@midnight-ntwrk/testkit-js';
import { MidnightWalletProvider } from './midnight-wallet-provider';
import { randomBytes } from '../../api/src/utils';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { syncWallet, waitForUnshieldedFunds } from './wallet-utils';
import { generateDust } from './generate-dust';
import { type PdexPrivateState } from '../../contract/src/witnesses.js';

// @ts-expect-error: It's needed to enable WebSocket usage through apollo
globalThis.WebSocket = WebSocket;

/* **********************************************************************
 * deployOrJoin: returns a DEX API, by prompting the user about
 * whether to deploy a new contract or join an existing one.
 */

const DEPLOY_OR_JOIN_QUESTION = `
You can do one of the following:
  1. Deploy a new DEX contract
  2. Join an existing DEX contract
  3. Exit
Which would you like to do? `;

const deployOrJoin = async (providers: PdexProviders, rli: Interface, logger: Logger): Promise<PdexAPI | null> => {
  while (true) {
    const choice = await rli.question(DEPLOY_OR_JOIN_QUESTION);
    switch (choice) {
      case '1': {
        const api = await PdexAPI.deploy(providers, logger);
        logger.info(`Deployed contract at address: ${api.deployedContractAddress}`);
        return api;
      }
      case '2': {
        const api = await PdexAPI.join(
          providers,
          await rli.question('What is the contract address (in hex)? '),
          logger,
        );
        logger.info(`Joined contract at address: ${api.deployedContractAddress}`);
        return api;
      }
      case '3':
        logger.info('Exiting...');
        return null;
      default:
        logger.error(`Invalid choice: ${choice}`);
    }
  }
};

/* **********************************************************************
 * Display helpers.
 */

const formatOrder = (o: OrderView): string =>
  [
    `#${o.id}`.padEnd(6),
    `${o.remaining}/${o.size}`.padStart(12),
    `@ ${o.price}`.padEnd(12),
    `min ${o.minFill}`.padEnd(10),
    o.isMine ? `yours${o.unclaimed > 0n ? `, unclaimed ${o.unclaimed}` : ''}` : '',
  ].join(' ');

const displayBook = (state: PdexDerivedState | undefined, logger: Logger) => {
  if (state === undefined) {
    logger.info('No order book state currently available');
    return;
  }
  const lines = [
    'ASKS (sell BASE)          size       price',
    ...[...state.asks].reverse().map(formatOrder),
    '-----------------------------------------',
    ...state.bids.map(formatOrder),
    'BIDS (buy BASE)',
  ];
  logger.info(`Order book\n${lines.join('\n')}`);
};

const displayBalances = async (wallet: WalletFacade, api: PdexAPI, logger: Logger) => {
  const state = await Rx.firstValueFrom(wallet.state());
  const balances = state.shielded.balances ?? {};
  logger.info(`Shielded balances: BASE=${balances[api.tokens.base] ?? 0n} QUOTE=${balances[api.tokens.quote] ?? 0n}`);
};

const displayPrivateState = async (providers: PdexProviders, logger: Logger): Promise<void> => {
  const privateState = await providers.privateStateProvider.get(pdexPrivateStateKey);
  if (privateState === null) {
    logger.info(`There is no existing DEX private state`);
  } else {
    logger.info(`Current secret key is: ${toHex(privateState.secretKey)}`);
  }
};

const askBigInt = async (rli: Interface, question: string): Promise<bigint> => {
  const answer = (await rli.question(question)).trim();
  if (!/^\d+$/.test(answer)) {
    throw new Error(`Not a whole number: '${answer}'`);
  }
  return BigInt(answer);
};

/* **********************************************************************
 * mainLoop: the main interactive menu of the DEX CLI.
 * Before starting the loop, the user is prompted to deploy a new
 * contract or join an existing one.
 */

const MAIN_LOOP_QUESTION = `
You can do one of the following:
  1. Show the order book
  2. Show your BASE / QUOTE balances
  3. Get test tokens from the faucet
  4. Place a limit order
  5. Fill an order
  6. Claim proceeds of your order
  7. Cancel your order
  8. Display the current private state (known only to this DApp instance)
  9. Exit
Which would you like to do? `;

const mainLoop = async (
  providers: PdexProviders,
  wallet: WalletFacade,
  rli: Interface,
  logger: Logger,
): Promise<void> => {
  const api = await deployOrJoin(providers, rli, logger);
  if (api === null) {
    return;
  }
  logger.info(`Token types: BASE=${api.tokens.base} QUOTE=${api.tokens.quote}`);
  let currentState: PdexDerivedState | undefined;
  const subscription = api.state$.subscribe({ next: (state) => (currentState = state) });
  try {
    while (true) {
      const choice = await rli.question(MAIN_LOOP_QUESTION);
      try {
        switch (choice) {
          case '1':
            displayBook(currentState, logger);
            break;
          case '2':
            await displayBalances(wallet, api, logger);
            break;
          case '3': {
            const token = (await rli.question('Which token, base or quote? ')).trim().toLowerCase();
            if (token !== 'base' && token !== 'quote') {
              throw new Error(`Unknown token '${token}'`);
            }
            await api.faucet(token, await askBigInt(rli, 'How much? '));
            break;
          }
          case '4': {
            const side = (await rli.question('Buy or sell BASE? ')).trim().toLowerCase();
            if (side !== 'buy' && side !== 'sell') {
              throw new Error(`Unknown side '${side}'`);
            }
            const price = await askBigInt(rli, 'Price (QUOTE for 1 BASE)? ');
            const size = await askBigInt(rli, 'Size (BASE)? ');
            const minFill = await askBigInt(rli, 'Min fill (BASE, 1 to size)? ');
            const id = await api.placeOrder(side === 'buy' ? Side.BUY : Side.SELL, price, size, minFill);
            logger.info(`Placed order #${id}`);
            break;
          }
          case '5': {
            const id = await askBigInt(rli, 'Order id? ');
            await api.fillOrder(id, await askBigInt(rli, 'Amount (BASE)? '));
            break;
          }
          case '6':
            await api.claim(await askBigInt(rli, 'Order id? '));
            break;
          case '7':
            await api.cancelOrder(await askBigInt(rli, 'Order id? '));
            break;
          case '8':
            await displayPrivateState(providers, logger);
            break;
          case '9':
            logger.info('Exiting...');
            return;
          default:
            logger.error(`Invalid choice: ${choice}`);
        }
      } catch (e) {
        logError(logger, e);
        logger.info('Returning to main menu...');
      }
    }
  } finally {
    // While we allow errors to bubble up to the 'run' function, we will always need to dispose of the state
    // subscription when we exit.
    subscription.unsubscribe();
  }
};

/* ***********************************************************************
 * This seed gives access to tokens minted in the genesis block of a local development node - only
 * used in standalone networks to build a wallet with initial funds.
 */
const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/* **********************************************************************
 * buildWallet: unless running in a standalone (offline) mode,
 * prompt the user to tell us whether to create a new wallet
 * or recreate one from a prior seed.
 */

const WALLET_LOOP_QUESTION = `
You can do one of the following:
  1. Build a fresh wallet
  2. Build wallet from a seed
  3. Exit
Which would you like to do? `;

const buildWallet = async (config: Config, rli: Interface, logger: Logger): Promise<string | undefined> => {
  if (config instanceof StandaloneConfig) {
    return GENESIS_MINT_WALLET_SEED;
  }
  while (true) {
    const choice = await rli.question(WALLET_LOOP_QUESTION);
    switch (choice) {
      case '1':
        return toHex(randomBytes(32));
      case '2':
        return await rli.question('Enter your wallet seed: ');
      case '3':
        logger.info('Exiting...');
        return undefined;
      default:
        logger.error(`Invalid choice: ${choice}`);
    }
  }
};

/* **********************************************************************
 * connect: builds and funds the wallet for `seed`, registers NIGHT for
 * DUST generation when the network needs it, and builds the providers
 * that the DEX API uses.
 */

export const connect = async (
  config: Config,
  envConfiguration: EnvironmentConfiguration,
  seed: string,
  logger: Logger,
): Promise<{ providers: PdexProviders; walletProvider: MidnightWalletProvider }> => {
  const walletProvider = await MidnightWalletProvider.build(logger, envConfiguration, seed);
  try {
    const walletFacade: WalletFacade = walletProvider.wallet;
    await walletProvider.start();

    const unshieldedState = await waitForUnshieldedFunds(logger, walletFacade, envConfiguration, unshieldedToken());
    const nightBalance = unshieldedState.balances[unshieldedToken().raw];
    if (nightBalance === undefined) {
      throw new Error('No funds received');
    }
    logger.info(`Your NIGHT wallet balance is: ${nightBalance}`);

    if (config.generateDust) {
      const dustGeneration = await generateDust(logger, seed, unshieldedState, walletFacade);
      if (dustGeneration) {
        logger.info(`Submitted dust generation registration transaction: ${dustGeneration}`);
        await syncWallet(logger, walletFacade);
      }
    }

    const zkConfigProvider = new NodeZkConfigProvider<PdexCircuitKeys>(config.zkConfigPath);
    const providers: PdexProviders = {
      privateStateProvider: levelPrivateStateProvider<PrivateStateId, PdexPrivateState>({
        privateStateStoreName: config.privateStateStoreName,
        signingKeyStoreName: `${config.privateStateStoreName}-signing-keys`,
        privateStoragePasswordProvider: () => {
          return 'Pdex-Test-Password-2026!';
        },
        accountId: seed,
      }),
      publicDataProvider: indexerPublicDataProvider(envConfiguration.indexer, envConfiguration.indexerWS),
      zkConfigProvider: zkConfigProvider,
      proofProvider: httpClientProofProvider(envConfiguration.proofServer, zkConfigProvider),
      walletProvider: walletProvider,
      midnightProvider: walletProvider,
    };
    return { providers, walletProvider };
  } catch (e) {
    await walletProvider.stop();
    throw e;
  }
};

/* **********************************************************************
 * run: the main entry point that starts the whole DEX CLI.
 *
 * If called with a Docker environment argument, the application
 * will wait for Docker to be ready before doing anything else.
 */

export const run = async (config: Config, testEnv: TestEnvironment, logger: Logger): Promise<void> => {
  const rli = createInterface({ input, output, terminal: true });
  const providersToBeStopped: MidnightWalletProvider[] = [];
  try {
    const envConfiguration = await testEnv.start();
    logger.info(`Environment started with configuration: ${JSON.stringify(envConfiguration)}`);
    const seed = await buildWallet(config, rli, logger);
    if (seed === undefined) {
      return;
    }
    const { providers, walletProvider } = await connect(config, envConfiguration, seed, logger);
    providersToBeStopped.push(walletProvider);
    const walletFacade: WalletFacade = walletProvider.wallet;
    await mainLoop(providers, walletFacade, rli, logger);
  } catch (e) {
    logError(logger, e);
    logger.info('Exiting...');
  } finally {
    try {
      rli.close();
      rli.removeAllListeners();
    } catch (e) {
      logError(logger, e);
    } finally {
      try {
        for (const wallet of providersToBeStopped) {
          logger.info('Stopping wallet...');
          await wallet.stop();
        }
        if (testEnv) {
          logger.info('Stopping test environment...');
          await testEnv.shutdown();
        }
      } catch (e) {
        logError(logger, e);
      }
    }
  }
};

function logError(logger: Logger, e: unknown) {
  if (e instanceof Error) {
    logger.error(`Found error '${e.message}'`);
    logger.debug(`${e.stack}`);
  } else {
    logger.error(`Found error (unknown type)`);
  }
}
