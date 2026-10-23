// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useState } from 'react';
import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  Alert,
  Backdrop,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  CircularProgress,
  Divider,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import CopyIcon from '@mui/icons-material/ContentPasteOutlined';
import RefreshIcon from '@mui/icons-material/RefreshOutlined';
import { type DeployedPdexAPI, type OrderView, type PdexDerivedState, Side } from '../../../api/src/index';
import { useDeployedDexContext } from '../hooks';
import { type DexDeployment } from '../contexts';
import { type Observable } from 'rxjs';
import { EmptyCardContent } from './Dex.EmptyCardContent';
import { TextPromptDialog } from './TextPromptDialog';

/** The props required by the {@link Dex} component. */
export interface DexProps {
  /** The observable DEX deployment. */
  dexDeployment$?: Observable<DexDeployment>;
}

const WHOLE_NUMBER = /^\d+$/;

/**
 * Provides the UI for a deployed DEX contract: the order book, the user's balances, and forms to get test
 * tokens, place, fill, claim and cancel orders.
 *
 * @remarks
 * With no `dexDeployment$` observable, the component renders a UI that allows the user to deploy or join
 * a DEX. When a `dexDeployment$` observable is received, the component waits for the `DeployedPdexAPI`
 * and then subscribes to its `state$` observable.
 */
export const Dex: React.FC<Readonly<DexProps>> = ({ dexDeployment$ }) => {
  const dexApiProvider = useDeployedDexContext();
  const [dexDeployment, setDexDeployment] = useState<DexDeployment>();
  const [api, setApi] = useState<DeployedPdexAPI>();
  const [dexState, setDexState] = useState<PdexDerivedState>();
  const [balances, setBalances] = useState<{ base: bigint; quote: bigint }>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [working, setWorking] = useState<string | undefined>(dexDeployment$ ? 'Connecting...' : undefined);
  const [fillTarget, setFillTarget] = useState<OrderView>();

  const [faucetToken, setFaucetToken] = useState<'base' | 'quote'>('base');
  const [faucetAmount, setFaucetAmount] = useState('1000');
  const [side, setSide] = useState<Side>(Side.SELL);
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [minFill, setMinFill] = useState('1');

  const onCreateDex = useCallback(() => dexApiProvider.resolve(), [dexApiProvider]);
  const onJoinDex = useCallback(
    (contractAddress: ContractAddress) => dexApiProvider.resolve(contractAddress),
    [dexApiProvider],
  );

  const refreshBalances = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const all = await dexApiProvider.shieldedBalances();
      setBalances({ base: all[api.tokens.base] ?? 0n, quote: all[api.tokens.quote] ?? 0n });
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [api, dexApiProvider]);

  // Runs one contract call, shows progress while it runs, and refreshes the balances after it.
  const run = useCallback(
    async (label: string, action: (api: DeployedPdexAPI) => Promise<unknown>) => {
      if (!api) {
        return;
      }
      setErrorMessage(undefined);
      setWorking(label);
      try {
        await action(api);
      } catch (error: unknown) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setWorking(undefined);
        void refreshBalances();
      }
    },
    [api, refreshBalances],
  );

  const onCopyContractAddress = useCallback(async () => {
    if (api) {
      await navigator.clipboard.writeText(api.deployedContractAddress);
    }
  }, [api]);

  // Subscribes to the `dexDeployment$` observable so that we can receive updates on the deployment.
  useEffect(() => {
    if (!dexDeployment$) {
      return;
    }
    const subscription = dexDeployment$.subscribe(setDexDeployment);
    return () => {
      subscription.unsubscribe();
    };
  }, [dexDeployment$]);

  // Subscribes to the `state$` observable of the `DeployedPdexAPI` when we receive one; otherwise shows
  // the deployment error.
  useEffect(() => {
    if (!dexDeployment || dexDeployment.status === 'in-progress') {
      return;
    }
    setWorking(undefined);
    if (dexDeployment.status === 'failed') {
      setErrorMessage(dexDeployment.error.message || 'Encountered an unexpected error.');
      return;
    }
    setApi(dexDeployment.api);
    const subscription = dexDeployment.api.state$.subscribe(setDexState);
    return () => {
      subscription.unsubscribe();
    };
  }, [dexDeployment]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  if (!dexDeployment$) {
    return (
      <Card sx={{ width: 320 }} color="primary">
        <EmptyCardContent onCreateDexCallback={onCreateDex} onJoinDexCallback={onJoinDex} />
      </Card>
    );
  }

  const orderValid =
    [price, size, minFill].every((v) => WHOLE_NUMBER.test(v)) &&
    BigInt(price) > 0n &&
    BigInt(size) > 0n &&
    BigInt(minFill) > 0n &&
    BigInt(minFill) <= BigInt(size);
  const escrowText = !orderValid
    ? ''
    : side === Side.SELL
      ? `Locks ${size} BASE`
      : `Locks ${BigInt(size) * BigInt(price)} QUOTE`;

  return (
    <Card sx={{ position: 'relative', width: '100%', maxWidth: 900 }} color="primary">
      <Backdrop
        sx={{ position: 'absolute', color: '#fff', zIndex: 1, flexDirection: 'column', gap: 2 }}
        open={!!working}
      >
        <CircularProgress data-testid="dex-working-indicator" />
        <Typography>{working}</Typography>
        <Typography variant="caption">Proving and balancing can take a minute.</Typography>
      </Backdrop>

      <CardHeader
        titleTypographyProps={{ color: 'primary' }}
        title={api ? <span data-testid="dex-address">{api.deployedContractAddress}</span> : 'Loading...'}
        subheader="Private order book: prices are public, makers are anonymous"
        action={
          api && (
            <IconButton title="Copy contract address" onClick={onCopyContractAddress}>
              <CopyIcon fontSize="small" />
            </IconButton>
          )
        }
      />

      <CardContent>
        {errorMessage && (
          <Alert severity="error" onClose={() => setErrorMessage(undefined)} sx={{ mb: 2 }} data-testid="dex-error">
            {errorMessage}
          </Alert>
        )}

        <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'center' }}>
          <Typography data-testid="dex-balances">
            Your shielded balances: BASE {balances?.base.toString() ?? '…'} · QUOTE {balances?.quote.toString() ?? '…'}
          </Typography>
          <IconButton title="Refresh balances" onClick={() => void refreshBalances()} size="small">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              Test faucet
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                select
                size="small"
                value={faucetToken}
                onChange={(e) => setFaucetToken(e.target.value as 'base' | 'quote')}
              >
                <MenuItem value="base">BASE</MenuItem>
                <MenuItem value="quote">QUOTE</MenuItem>
              </TextField>
              <TextField
                size="small"
                label="Amount"
                value={faucetAmount}
                onChange={(e) => setFaucetAmount(e.target.value.trim())}
              />
              <Button
                variant="outlined"
                data-testid="dex-faucet-btn"
                disabled={!api || !WHOLE_NUMBER.test(faucetAmount)}
                onClick={() => void run('Minting test tokens...', (a) => a.faucet(faucetToken, BigInt(faucetAmount)))}
              >
                Mint
              </Button>
            </Stack>
          </Box>

          <Box sx={{ flex: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Place a limit order
            </Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField select size="small" value={side} onChange={(e) => setSide(Number(e.target.value))}>
                <MenuItem value={Side.BUY}>Buy BASE</MenuItem>
                <MenuItem value={Side.SELL}>Sell BASE</MenuItem>
              </TextField>
              <TextField
                size="small"
                label="Price (QUOTE / BASE)"
                value={price}
                onChange={(e) => setPrice(e.target.value.trim())}
              />
              <TextField
                size="small"
                label="Size (BASE)"
                value={size}
                onChange={(e) => setSize(e.target.value.trim())}
              />
              <TextField
                size="small"
                label="Min fill"
                value={minFill}
                onChange={(e) => setMinFill(e.target.value.trim())}
              />
              <Button
                variant="contained"
                data-testid="dex-place-btn"
                disabled={!api || !orderValid}
                onClick={() =>
                  void run('Placing order...', (a) => a.placeOrder(side, BigInt(price), BigInt(size), BigInt(minFill)))
                }
              >
                Place
              </Button>
            </Stack>
            <Typography variant="caption">{escrowText}</Typography>
          </Box>
        </Stack>

        <Divider sx={{ mb: 1 }} />

        {dexState ? (
          <OrderBook
            state={dexState}
            onFill={setFillTarget}
            onClaim={(o) => void run(`Claiming order #${o.id}...`, (a) => a.claim(o.id))}
            onCancel={(o) => void run(`Cancelling order #${o.id}...`, (a) => a.cancelOrder(o.id))}
          />
        ) : (
          <Skeleton variant="rectangular" height={200} />
        )}
      </CardContent>

      <TextPromptDialog
        prompt={
          fillTarget
            ? `Fill order #${fillTarget.id}: how much BASE? (${fillTarget.minFill < fillTarget.remaining ? fillTarget.minFill : fillTarget.remaining} to ${fillTarget.remaining}, price ${fillTarget.price})`
            : ''
        }
        isOpen={!!fillTarget}
        onCancel={() => setFillTarget(undefined)}
        onSubmit={(text) => {
          const order = fillTarget;
          setFillTarget(undefined);
          if (!order || !WHOLE_NUMBER.test(text.trim())) {
            setErrorMessage(`Not a whole number: '${text}'`);
            return;
          }
          void run(`Filling order #${order.id}...`, (a) => a.fillOrder(order.id, BigInt(text.trim())));
        }}
      />
    </Card>
  );
};

interface OrderBookProps {
  state: PdexDerivedState;
  onFill: (order: OrderView) => void;
  onClaim: (order: OrderView) => void;
  onCancel: (order: OrderView) => void;
}

/** Asks above (lowest price nearest the spread), bids below. */
const OrderBook: React.FC<Readonly<OrderBookProps>> = ({ state, onFill, onClaim, onCancel }) => {
  const row = (o: OrderView) => (
    <TableRow key={o.id.toString()} data-testid={`dex-order-${o.id}`}>
      <TableCell>#{o.id.toString()}</TableCell>
      <TableCell sx={{ color: o.side === Side.SELL ? 'error.main' : 'success.main' }}>
        {o.side === Side.SELL ? 'ASK' : 'BID'}
      </TableCell>
      <TableCell align="right">{o.price.toString()}</TableCell>
      <TableCell align="right">
        {o.remaining.toString()} / {o.size.toString()}
      </TableCell>
      <TableCell align="right">{o.minFill.toString()}</TableCell>
      <TableCell>{o.isMine ? `yours${o.unclaimed > 0n ? ` · unclaimed ${o.unclaimed}` : ''}` : 'anonymous'}</TableCell>
      <TableCell align="right">
        {o.isMine ? (
          <>
            <Button size="small" disabled={o.unclaimed === 0n} onClick={() => onClaim(o)}>
              Claim
            </Button>
            <Button size="small" color="error" onClick={() => onCancel(o)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="small" variant="outlined" disabled={o.remaining === 0n} onClick={() => onFill(o)}>
            {o.side === Side.SELL ? 'Buy' : 'Sell'}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );

  return (
    <Table size="small" data-testid="dex-order-book">
      <TableHead>
        <TableRow>
          <TableCell>Order</TableCell>
          <TableCell>Side</TableCell>
          <TableCell align="right">Price</TableCell>
          <TableCell align="right">Remaining / size</TableCell>
          <TableCell align="right">Min fill</TableCell>
          <TableCell>Maker</TableCell>
          <TableCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {state.asks.length + state.bids.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} align="center">
              The book is empty. Mint test tokens and place the first order.
            </TableCell>
          </TableRow>
        )}
        {[...state.asks].reverse().map(row)}
        {state.asks.length > 0 && state.bids.length > 0 && (
          <TableRow>
            <TableCell colSpan={7} sx={{ py: 0.5, bgcolor: 'action.hover' }} />
          </TableRow>
        )}
        {state.bids.map(row)}
      </TableBody>
    </Table>
  );
};
