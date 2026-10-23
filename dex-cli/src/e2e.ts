// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

/*
 * A scripted run of the whole DEX flow against a real network:
 * deploy, faucet, place, fill, claim and cancel. One wallet is both maker and
 * taker, which the contract allows. The script checks the shielded wallet
 * balances after each step, so it proves that coins move as the contract says.
 */

import * as Rx from 'rxjs';
import { type Logger } from 'pino';
import { type TestEnvironment } from '@midnight-ntwrk/testkit-js';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { type WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { PdexAPI, Side } from '../../api/src/index';
import { randomBytes } from '../../api/src/utils';
import { type Config } from './config.js';
import { connect } from './index.js';

type Balances = { base: bigint; quote: bigint };

const balances = async (wallet: WalletFacade, api: PdexAPI): Promise<Balances> => {
  const state = await Rx.firstValueFrom(wallet.state());
  const all = state.shielded.balances ?? {};
  return { base: all[api.tokens.base] ?? 0n, quote: all[api.tokens.quote] ?? 0n };
};

/** Waits until the wallet shows `expected`, because the wallet syncs new coins after the transaction. */
const expectBalances = async (wallet: WalletFacade, api: PdexAPI, expected: Balances, logger: Logger) => {
  const actual = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.map((state) => state.shielded.balances ?? {}),
      Rx.map((all) => ({ base: all[api.tokens.base] ?? 0n, quote: all[api.tokens.quote] ?? 0n })),
      Rx.filter((b) => b.base === expected.base && b.quote === expected.quote),
      Rx.timeout({ first: 180_000, with: () => Rx.from(balances(wallet, api)) }),
    ),
  );
  if (actual.base !== expected.base || actual.quote !== expected.quote) {
    throw new Error(
      `Balances: expected BASE=${expected.base} QUOTE=${expected.quote}, got BASE=${actual.base} QUOTE=${actual.quote}`,
    );
  }
  logger.info(`OK balances BASE=${actual.base} QUOTE=${actual.quote}`);
};

export const runE2E = async (config: Config, testEnv: TestEnvironment, logger: Logger): Promise<void> => {
  const seed = process.env.PDEX_SEED?.trim() || toHex(randomBytes(32));
  logger.info(`Wallet seed (set PDEX_SEED to reuse this funded wallet): ${seed}`);
  const envConfiguration = await testEnv.start();
  const { providers, walletProvider } = await connect(config, envConfiguration, seed, logger);
  const wallet = walletProvider.wallet;
  try {
    const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      logger.info(`STEP ${name}`);
      const started = Date.now();
      const result = await action();
      logger.info(`DONE ${name} in ${Math.round((Date.now() - started) / 1000)}s`);
      return result;
    };

    const api = await step('deploy', () => PdexAPI.deploy(providers, logger));
    logger.info(`Contract address: ${api.deployedContractAddress}`);

    await step('faucet BASE 100', () => api.faucet('base', 100n));
    await step('faucet QUOTE 1000', () => api.faucet('quote', 1000n));
    await expectBalances(wallet, api, { base: 100n, quote: 1000n }, logger);

    const id = await step('place SELL 10 @ 3, min fill 2', () => api.placeOrder(Side.SELL, 3n, 10n, 2n));
    await expectBalances(wallet, api, { base: 90n, quote: 1000n }, logger);

    await step(`fill 4 of #${id}`, () => api.fillOrder(id, 4n));
    await expectBalances(wallet, api, { base: 94n, quote: 988n }, logger);

    const book = await Rx.firstValueFrom(api.state$);
    const order = book.asks.find((o) => o.id === id);
    if (!order?.isMine || order.remaining !== 6n || order.unclaimed !== 12n) {
      throw new Error(
        `Unexpected order view: ${JSON.stringify(order, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`,
      );
    }
    logger.info('OK order view: yours, 6 remain, 12 QUOTE unclaimed');

    await step(`claim #${id}`, () => api.claim(id));
    await expectBalances(wallet, api, { base: 94n, quote: 1000n }, logger);

    await step(`cancel #${id}`, () => api.cancelOrder(id));
    await expectBalances(wallet, api, { base: 100n, quote: 1000n }, logger);

    logger.info(`E2E PASSED on ${envConfiguration.networkId}. Contract: ${api.deployedContractAddress}`);
  } finally {
    await walletProvider.stop();
    await testEnv.shutdown();
  }
};
