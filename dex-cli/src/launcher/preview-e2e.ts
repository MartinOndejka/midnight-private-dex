// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '../logger-utils.js';
import { runE2E } from '../e2e.js';
import { PreviewRemoteConfig } from '../config.js';

const config = new PreviewRemoteConfig();
const logger = await createLogger(config.logDir);
const testEnvironment = config.getEnvironment(logger);
try {
  await runE2E(config, testEnvironment, logger);
} catch (e) {
  logger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
}
