import { describe, expect, it } from 'vitest';
import {
  Cart,
  computeTotals,
  DELIVERY_PENCE,
  FREE_DELIVERY_THRESHOLD_PENCE,
  formatPence,
  ACTION_MANIFEST,
  runAction
} from '@forge/fixture-catalog';

describe('fixture catalogue totals', () => {
  it('charges delivery below the threshold and waives it above', () => {
    const small = computeTotals([{ productId: 'sku-mug', quantity: 1 }]);
    expect(small.subtotalPence).toBe(1200);
    expect(small.deliveryPence).toBe(DELIVERY_PENCE);
    expect(small.totalPence).toBe(1200 + DELIVERY_PENCE);

    const large = computeTotals([{ productId: 'sku-tee', quantity: 2 }]);
    expect(large.subtotalPence).toBeGreaterThanOrEqual(FREE_DELIVERY_THRESHOLD_PENCE);
    expect(large.deliveryPence).toBe(0);
  });

  it('an empty cart has no delivery charge', () => {
    const totals = computeTotals([]);
    expect(totals.totalPence).toBe(0);
    expect(totals.itemCount).toBe(0);
  });

  it('rejects unknown products', () => {
    expect(() => computeTotals([{ productId: 'nope', quantity: 1 }])).toThrow();
  });

  it('formats pence as pounds', () => {
    expect(formatPence(1200)).toBe('£12.00');
  });
});

describe('fixture cart operations', () => {
  it('accumulates quantities and clears', () => {
    const cart = new Cart();
    cart.add('sku-mug', 1);
    cart.add('sku-mug', 2);
    expect(cart.totals().itemCount).toBe(3);
    cart.setQuantity('sku-mug', 0);
    expect(cart.totals().itemCount).toBe(0);
  });
});

describe('fixture structured actions', () => {
  it('publishes a manifest and dispatches actions against a cart', () => {
    expect(ACTION_MANIFEST.tools.map((t) => t.name)).toEqual([
      'list_products',
      'reset_cart',
      'add_to_cart',
      'get_cart'
    ]);
    const cart = new Cart();
    expect(runAction(cart, 'add_to_cart', { productId: 'sku-cap', quantity: 2 }).ok).toBe(true);
    const state = runAction(cart, 'get_cart', {});
    expect((state.data.totals as { itemCount: number }).itemCount).toBe(2);
    expect(runAction(cart, 'add_to_cart', { productId: 'ghost' }).ok).toBe(false);
    expect(runAction(cart, 'unknown_action', {}).ok).toBe(false);
  });
});
