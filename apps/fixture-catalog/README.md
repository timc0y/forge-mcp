# Forge fixture catalogue

A generic, dependency-free web application used to prove the complete Forge
repository-local workflow. It is not tied to any real company or service.

- Small product catalogue (`/api/products`) and cart-like state (`/api/cart`).
- A development server (`pnpm --filter @forge/fixture-catalog dev`, port 4321).
- Structured test actions at `/__forge/actions` (manifest) and
  `POST /__forge/actions/:name` (dispatch): `list_products`, `reset_cart`,
  `add_to_cart`, `get_cart`.
- Visible UI states for phone and desktop review.
- No real external services, money, inventory or identity.

Pure logic lives in `src/catalog.ts` (catalogue + totals + cart) and
`src/actions.ts` (structured actions); `src/server.ts` wires the HTTP surface.
Tests: `tests/unit/fixture-catalog.test.ts`.
