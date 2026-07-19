/**
 * A tiny, self-contained product catalogue and cart. No external services, no
 * database — deterministic in-memory state. This is the generic fixture web
 * application Forge uses to prove the complete repository-local workflow:
 * catalogue, cart-like state, visible UI states, phone and desktop review, and
 * structured test actions.
 */

export interface Product {
  id: string;
  name: string;
  /** Price in minor units (pence) to avoid floating-point money bugs. */
  pricePence: number;
  currency: 'GBP';
}

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface CartTotals {
  lines: Array<CartLine & { name: string; lineTotalPence: number }>;
  subtotalPence: number;
  /** Flat delivery, free over the threshold. */
  deliveryPence: number;
  totalPence: number;
  itemCount: number;
}

export const PRODUCTS: readonly Product[] = [
  { id: 'sku-mug', name: 'Forge Mug', pricePence: 1200, currency: 'GBP' },
  { id: 'sku-tee', name: 'Forge T-Shirt', pricePence: 2200, currency: 'GBP' },
  { id: 'sku-cap', name: 'Forge Cap', pricePence: 1800, currency: 'GBP' },
  { id: 'sku-stickers', name: 'Sticker Pack', pricePence: 500, currency: 'GBP' }
];

export const DELIVERY_PENCE = 499;
export const FREE_DELIVERY_THRESHOLD_PENCE = 4000;

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((product) => product.id === id);
}

/**
 * Compute cart totals deterministically. Delivery is free once the subtotal
 * reaches the threshold; an empty cart has no delivery charge.
 */
export function computeTotals(lines: readonly CartLine[]): CartTotals {
  const resolved = lines
    .filter((line) => line.quantity > 0)
    .map((line) => {
      const product = findProduct(line.productId);
      if (!product) throw new Error(`Unknown product: ${line.productId}`);
      return {
        productId: line.productId,
        quantity: line.quantity,
        name: product.name,
        lineTotalPence: product.pricePence * line.quantity
      };
    });
  const subtotalPence = resolved.reduce((sum, line) => sum + line.lineTotalPence, 0);
  const itemCount = resolved.reduce((sum, line) => sum + line.quantity, 0);
  const deliveryPence =
    subtotalPence === 0 || subtotalPence >= FREE_DELIVERY_THRESHOLD_PENCE ? 0 : DELIVERY_PENCE;
  return {
    lines: resolved,
    subtotalPence,
    deliveryPence,
    totalPence: subtotalPence + deliveryPence,
    itemCount
  };
}

/** A mutable cart with the operations the UI and structured actions expose. */
export class Cart {
  private readonly quantities = new Map<string, number>();

  add(productId: string, quantity = 1): void {
    if (!findProduct(productId)) throw new Error(`Unknown product: ${productId}`);
    if (quantity <= 0) throw new Error('Quantity must be positive.');
    this.quantities.set(productId, (this.quantities.get(productId) ?? 0) + quantity);
  }

  setQuantity(productId: string, quantity: number): void {
    if (!findProduct(productId)) throw new Error(`Unknown product: ${productId}`);
    if (quantity <= 0) this.quantities.delete(productId);
    else this.quantities.set(productId, quantity);
  }

  clear(): void {
    this.quantities.clear();
  }

  lines(): CartLine[] {
    return [...this.quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  }

  totals(): CartTotals {
    return computeTotals(this.lines());
  }
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}
