import { Cart, PRODUCTS, findProduct, formatPence } from './catalog.ts';

/**
 * Structured development/testing actions the fixture exposes for Forge to
 * discover and drive generically. This is deliberately NOT tied to Forge's
 * internals: it is a plain manifest of named actions with JSON-Schema-shaped
 * inputs plus a dispatcher, exactly what a real app would publish behind a
 * protected preview. Actions never touch real money, inventory or identity.
 */

export interface StructuredActionDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StructuredActionManifest {
  schemaVersion: 1;
  tools: StructuredActionDef[];
}

export const ACTION_MANIFEST: StructuredActionManifest = {
  schemaVersion: 1,
  tools: [
    { name: 'list_products', description: 'List the catalogue.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'reset_cart',
      description: 'Empty the cart to a known state.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'add_to_cart',
      description: 'Add a product to the cart.',
      inputSchema: {
        type: 'object',
        required: ['productId'],
        properties: {
          productId: { type: 'string' },
          quantity: { type: 'integer', minimum: 1, default: 1 }
        }
      }
    },
    {
      name: 'get_cart',
      description: 'Return current cart lines and totals.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
};

export interface ActionResult {
  ok: boolean;
  /** A compact, safe summary of the outcome — never secrets or raw internals. */
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Dispatch a structured action against a cart. Pure with respect to the passed
 * cart: state changes are confined to that cart instance.
 */
export function runAction(cart: Cart, name: string, input: Record<string, unknown>): ActionResult {
  switch (name) {
    case 'list_products':
      return {
        ok: true,
        summary: `${PRODUCTS.length} products`,
        data: { products: PRODUCTS }
      };
    case 'reset_cart': {
      cart.clear();
      return { ok: true, summary: 'cart cleared', data: { totals: cart.totals() } };
    }
    case 'add_to_cart': {
      const productId = String(input.productId ?? '');
      const quantity = input.quantity === undefined ? 1 : Number(input.quantity);
      if (!findProduct(productId)) {
        return { ok: false, summary: `unknown product ${productId}`, data: {} };
      }
      cart.add(productId, quantity);
      const totals = cart.totals();
      return {
        ok: true,
        summary: `added ${quantity} × ${findProduct(productId)?.name}; total ${formatPence(totals.totalPence)}`,
        data: { totals }
      };
    }
    case 'get_cart': {
      const totals = cart.totals();
      return {
        ok: true,
        summary: `${totals.itemCount} item(s); total ${formatPence(totals.totalPence)}`,
        data: { totals }
      };
    }
    default:
      return { ok: false, summary: `unknown action ${name}`, data: {} };
  }
}
