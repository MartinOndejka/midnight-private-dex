// Private order book DEX for Midnight.
// SPDX-License-Identifier: Apache-2.0

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { describe, it, expect, beforeEach } from "vitest";
import { PdexSimulator, newUser, type User } from "./pdex-simulator.js";
import { Side, pureCircuits } from "../managed/pdex/contract/index.js";
import { encodeContractAddress } from "@midnight-ntwrk/compact-runtime";

setNetworkId("undeployed");

const BASE = true;
const QUOTE = false;

describe("Private order book DEX", () => {
  let maker: User;
  let taker: User;
  let sim: PdexSimulator;

  beforeEach(() => {
    maker = newUser();
    taker = newUser();
    sim = new PdexSimulator(maker);
  });

  it("starts with an empty book", () => {
    const l = sim.getLedger();
    expect(l.orders.isEmpty()).toBe(true);
    expect(l.escrow.isEmpty()).toBe(true);
    expect(l.proceeds.isEmpty()).toBe(true);
    expect(l.nextOrderId).toBe(1n);
  });

  it("faucet mints BASE and QUOTE to the caller", () => {
    const base = sim.faucet(BASE, 100n);
    expect(base.color).toEqual(sim.colors.base);
    expect(base.value).toBe(100n);
    const quote = sim.faucet(QUOTE, 50n);
    expect(quote.color).toEqual(sim.colors.quote);
    expect(quote.nonce).not.toEqual(base.nonce);
  });

  it("places a SELL order with an unlinkable owner commitment", () => {
    const id1 = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n));
    const id2 = sim.placeOrder(Side.SELL, 4n, 5n, sim.coin(BASE, 5n));
    const l = sim.getLedger();
    expect([id1, id2]).toEqual([1n, 2n]);
    const o1 = l.orders.lookup(id1);
    expect(o1).toMatchObject({
      side: Side.SELL,
      price: 3n,
      size: 10n,
      remaining: 10n,
    });
    expect(o1.owner).toEqual(
      pureCircuits.ownerCommitment(
        encodeContractAddress(sim.address),
        id1,
        maker.secretKey,
      ),
    );
    // Same maker, two orders: the commitments do not match.
    expect(l.orders.lookup(id2).owner).not.toEqual(o1.owner);
    expect(l.escrow.lookup(id1).value).toBe(10n);
  });

  it("places a BUY order with QUOTE escrow of size * price", () => {
    const id = sim.placeOrder(Side.BUY, 3n, 10n, sim.coin(QUOTE, 30n));
    expect(sim.getLedger().escrow.lookup(id).value).toBe(30n);
  });

  it("rejects wrong escrow token or amount", () => {
    expect(() =>
      sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(QUOTE, 10n)),
    ).toThrow("Wrong escrow token");
    expect(() =>
      sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 9n)),
    ).toThrow("Wrong escrow amount");
    expect(() =>
      sim.placeOrder(Side.BUY, 3n, 10n, sim.coin(QUOTE, 10n)),
    ).toThrow("Wrong escrow amount");
    expect(() =>
      sim.placeOrder(Side.SELL, 0n, 10n, sim.coin(BASE, 10n)),
    ).toThrow("Price must be positive");
  });

  it("partially fills a SELL order, then fills the rest", () => {
    const id = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n));

    sim.as(taker).fillOrder(id, 4n, sim.coin(QUOTE, 12n));
    const toTaker = sim
      .outputs()
      .filter(
        (o) => o.recipient.is_left && o.recipient.left === taker.coinPublicKey,
      );
    expect(toTaker.map((o) => o.coinInfo.value)).toEqual([4n]);
    let l = sim.getLedger();
    expect(l.orders.lookup(id).remaining).toBe(6n);
    expect(l.escrow.lookup(id).value).toBe(6n);
    expect(l.proceeds.lookup(id).value).toBe(12n);

    sim.as(taker).fillOrder(id, 6n, sim.coin(QUOTE, 18n));
    l = sim.getLedger();
    expect(l.orders.lookup(id).remaining).toBe(0n);
    expect(l.escrow.member(id)).toBe(false);
    expect(l.proceeds.lookup(id).value).toBe(30n);
  });

  it("fills a BUY order: taker pays BASE and gets QUOTE", () => {
    const id = sim.placeOrder(Side.BUY, 3n, 10n, sim.coin(QUOTE, 30n));
    sim.as(taker).fillOrder(id, 2n, sim.coin(BASE, 2n));
    const l = sim.getLedger();
    expect(l.escrow.lookup(id).value).toBe(24n);
    expect(l.proceeds.lookup(id).value).toBe(2n);
    expect(l.proceeds.lookup(id).color).toEqual(sim.colors.base);
  });

  it("rejects bad fills", () => {
    const id = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n));
    sim.as(taker);
    expect(() => sim.fillOrder(id, 11n, sim.coin(QUOTE, 33n))).toThrow(
      "more than remaining",
    );
    expect(() => sim.fillOrder(id, 2n, sim.coin(QUOTE, 5n))).toThrow(
      "Wrong payment amount",
    );
    expect(() => sim.fillOrder(id, 2n, sim.coin(BASE, 6n))).toThrow(
      "Wrong payment token",
    );
    expect(() => sim.fillOrder(99n, 1n, sim.coin(QUOTE, 3n))).toThrow(
      "No such order",
    );
  });

  it("lets only the maker claim, and removes a fully filled order", () => {
    const id = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n));
    sim.as(taker).fillOrder(id, 10n, sim.coin(QUOTE, 30n));

    expect(() => sim.as(taker).claim(id)).toThrow("Not the order owner");

    sim.as(maker).claim(id);
    const l = sim.getLedger();
    expect(l.proceeds.member(id)).toBe(false);
    expect(l.orders.member(id)).toBe(false);
  });

  it("keeps a partly filled order on the book after claim", () => {
    const id = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n));
    sim.as(taker).fillOrder(id, 4n, sim.coin(QUOTE, 12n));
    sim.as(maker).claim(id);
    const l = sim.getLedger();
    expect(l.orders.lookup(id).remaining).toBe(6n);
    expect(l.proceeds.member(id)).toBe(false);
    expect(() => sim.claim(id)).toThrow("Nothing to claim");
  });

  it("lets only the maker cancel, and returns escrow and proceeds", () => {
    const id = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n));
    sim.as(taker).fillOrder(id, 4n, sim.coin(QUOTE, 12n));

    expect(() => sim.as(taker).cancelOrder(id)).toThrow("Not the order owner");

    sim.as(maker).cancelOrder(id);
    const l = sim.getLedger();
    expect(l.orders.member(id)).toBe(false);
    expect(l.escrow.member(id)).toBe(false);
    expect(l.proceeds.member(id)).toBe(false);
  });

  it("enforces min fill, except for the last fill", () => {
    expect(() =>
      sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n), 11n),
    ).toThrow("Min fill must be from 1 to size");
    const id = sim.placeOrder(Side.SELL, 3n, 10n, sim.coin(BASE, 10n), 4n);
    sim.as(taker);
    expect(() => sim.fillOrder(id, 3n, sim.coin(QUOTE, 9n))).toThrow(
      "less than min fill",
    );
    sim.fillOrder(id, 7n, sim.coin(QUOTE, 21n));
    // 3 remain, which is less than min fill, but it is all of the rest.
    sim.fillOrder(id, 3n, sim.coin(QUOTE, 9n));
    expect(sim.getLedger().orders.lookup(id).remaining).toBe(0n);
  });

  it("gives one key different commitments in different deployments", () => {
    const other = new Uint8Array(32).fill(7);
    expect(
      pureCircuits.ownerCommitment(other, 1n, maker.secretKey),
    ).not.toEqual(
      pureCircuits.ownerCommitment(
        encodeContractAddress(sim.address),
        1n,
        maker.secretKey,
      ),
    );
  });
});
