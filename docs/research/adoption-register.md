# Adoption register

Dependency snapshot from 24 October 2026. Check package files for current versions
and your own account for deployed resources.

## Active dependencies and integrations

| Dependency | Current pin or surface | Purpose and boundary |
|---|---|---|
| Cloudflare Agents | `agents` 0.17.3 | MCP transport and one SQLite Durable Object binding |
| MCP TypeScript SDK | 1.32.2 | Five tools; clients can cache older catalog metadata |
| Zod | 4.6.6 | Strict tool schemas; catalog bytes recur every model turn |
| TypeScript | 5.9.3 | Browser-compiled syntax parser; Node analysis CLI retains filesystem APIs |
| Shopify Liquid parser / Lezer Markdown / YAML | 2.10.0 / 1.6.3 / 2.9.0 | Format-owner structure and exact source spans |
| Jose | 6.2.9 | Cryptographic utilities alongside Worker Web Crypto |
| Cloudflare Browser Rendering | REST `/snapshot` | Inline public-page screenshots; source restricts consenting logins; browser isolation depends on the provider |
| Cloudflare D1 | `METADATA` | Identity, OAuth, approval evidence, capture counters and anonymous shared inference budgets |
| Configured Cloudflare JEV route | `typesafe/jev` | One inference route and validated output contract; explicit private-source policy, no alternate model/provider |
| GitHub App user OAuth | REST API `2022-11-28` | Human and App repository permissions intersect; encrypted credential is resolved on each request/approval |
| OAuth 2.1 + PKCE | RFC 9728 metadata; S256 | Redirect hosts, signing-key rotation and session ownership remain boundaries |
| Wrangler / Workers types | 4.149.0 / 5.20261006.1 | Deployment/build tooling and runtime types |
| Vitest / Vite / esbuild / Node types | 5.0.3 / 8.2.4 / 0.28.1 / 24.10.1 | Checks, parser build and script types; runtime and script checks |

## Removed or rejected

| System | Status and retained obligation |
|---|---|
| Sandbox SDK, containers, execution, Workflows | Removed; GitHub holds authored work and T3 Code owns execution |
| R2/gallery/general artifact storage | Removed from current runtime; historical capture ownership/objects require the deletion runbook and independent removal evidence |
| Direct Workers AI binding | Not used; JEV uses the configured Cloudflare HTTP route |
| PostHog | Removed; shape-only operational measurements stay in Cloudflare |
| MCP Apps widget / `@modelcontextprotocol/ext-apps` | Removed/rejected; signed approval pages and inline images carry evidence |
| Cloudflare Code Mode | Not adopted; a facade does not earn a second policy/selection path |
| Executor-era progress gate | Historical; no command/workspace lifecycle remains |

Reconsider removed systems only when a measured user need cannot fit GitHub
writes, one-shot public capture or a durable human approval link. See the
[historical record](./forge-history-tool-learnings.md).

## Dependency security review — 24 October 2026

Exact direct pins and integrity hashes live in `worker/package.json` and
`worker/pnpm-lock.yaml`. `pnpm install --frozen-lockfile` succeeds. The changes
preserve Agents 0.17.3, the existing Durable Object transport and all five tools.

| Package | Before → after | Reason |
|---|---|---|
| MCP SDK | 1.30.0 → 1.32.2 | [1.32 security changes](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0), then [current 1.x patch fixes](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.2); no v2 migration |
| Zod | 4.4.3 → 4.6.6 | [Collection bounds before element validation](https://github.com/colinhacks/zod/releases/tag/v4.6.6) |
| Vite | auto-installed peer 8.2.2 → explicit dev pin 8.2.4 | Existing Vitest/Agents peer ranges admit 8.x; explicit pin fixes six [development-server/editor advisories](https://github.com/vitejs/vite/releases/tag/v8.2.4) |
| Vitest | 5.0.1 → 5.0.3 | Fixes two `@vitest/mocker` advisories through its exact dependency |
| Wrangler | 4.141.0 → 4.149.0 | Earliest 4.x release with [sharp 0.35.5](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.149.0); keeps the existing Miniflare 5 alpha family |
| Workers types | 5.20260925.1 → 5.20261006.1 | Meets Wrangler 4.149.0's declared peer requirement |
| Miniflare's Undici | 7.29.0 → 7.30.1 | [Security fixes](https://github.com/nodejs/undici/releases/tag/v7.30.1); scoped override explained below |
| `proxy-addr` / `body-parser` / `qs` | 2.0.7 / 2.3.0 / 6.15.3 → 2.0.8 / 2.4.0 / 6.16.1 | Semver-compatible lockfile refresh under the SDK's Express dependency |
| `fast-uri` / `hono` / `ip-address` | 3.1.5 / 4.13.3 / 10.5.0 → 3.1.9 / 4.13.13 / 10.7.4 | Semver-compatible lockfile refresh under SDK dependencies |
| `source-map-js` | 1.2.1 → 1.2.2 | Semver-compatible tooling dependency refresh |

Two overrides have an identified owner and exit condition:

- `@modelcontextprotocol/sdk: 1.32.2` keeps Forge and Agents on one SDK.
  Agents 0.17.3 declares an exact dependency on vulnerable SDK 1.29.0;
  its Zod peer accepts 4.6.6. Remove this override when the retained Agents
  version itself resolves the same supported, fixed SDK without it.
- `miniflare>undici: 7.30.1` applies only to Wrangler's local runtime tooling.
  Miniflare 5.20261006.1-alpha pins Undici 7.29.1 exactly, so a semver-safe
  lock refresh cannot replace it. Even Wrangler 4.152.0 still pins 7.29.1.
  Remove the override when the chosen Wrangler/Miniflare dependency admits or
  pins Undici 7.30.1 or a later fixed release and both audits stay clear.

Fresh `pnpm audit --prod --json`: **37 → 0 advisory records**, covering
252 resolved dependencies. An initial all-dependency audit after the runtime
refresh found 16 additional development-tool records; the final
`pnpm audit --json` reports **0**, covering 354 resolved dependencies.
Counts describe registry advisory records, not independently exploitable bugs
or complete security proof. The production audit includes tooling pulled
through Agents peers; it does not measure deployed reachability.

The [SDK memory advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453)
requires configuration as well as an upgrade. `maxToolInputElements` is off by
default; Forge configures 10,000 elements. Agents 0.17.3's `McpAgent.serve()`
checks declared `Content-Length` before `request.json()`, without the SDK
WebStandard transport's `maxRequestBodySize` option. Forge must enforce the raw
body limit before that parser, including bodies without a trustworthy length.
Forge does not configure the experimental `taskStore` or SDK Express bearer
middleware; its router owns authentication and session authority.

A disposable local probe passed real SDK client/server initialization,
five-tool JSON Schema listing, a valid read, invalid Zod input rejection and
the 10,000-element limit with no provider calls. Router tests and a local Worker
startup separately establish the host-facing transport boundary; a dependency
audit or in-memory probe does not establish live deployment behaviour.

## Direct-dependency licences — 24 October 2026

The project now has an [MIT licence](../../LICENSE). The table below was read
from each installed direct package's `package.json` and root licence/notice
files, against the pinned `worker/package.json`/lockfile. It describes those
packages; it does not relicense them or certify every platform-specific
dependency or a separately redistributed bundle.

| Package | Installed version | Declared licence | Licence/notice files at package root |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | `LICENSE` |
| `agents` | 0.17.3 | MIT | `LICENSE` |
| `jose` | 6.2.9 | MIT | `LICENSE.md` |
| `@shopify/liquid-html-parser` | 2.10.0 | MIT | `LICENSE.md` |
| `@lezer/markdown` | 1.6.3 | MIT | `LICENSE` |
| `typescript` | 5.9.3 | Apache-2.0 | `LICENSE.txt`, `ThirdPartyNoticeText.txt` |
| `yaml` | 2.9.0 | ISC | `LICENSE` |
| `zod` | 4.6.6 | MIT | `LICENSE` |
| `@cloudflare/workers-types` | 5.20261006.1 | MIT OR Apache-2.0 | None at package root; declaration observed |
| `vitest` | 5.0.3 | MIT | `LICENSE.md` |
| `vite` | 8.2.4 | MIT | `LICENSE.md` |
| `wrangler` | 4.149.0 | MIT OR Apache-2.0 | None at package root; declaration observed |
| `@types/node` | 24.10.1 | MIT | `LICENSE` |
| `esbuild` | 0.28.1 | MIT | `LICENSE.md` |

Keep upstream copyright/licence notices with redistributed dependency code.
The runtime review below uses the emitted Worker graph. Cloudflare, GitHub,
clients and JEV have separate service/model terms and costs; the project licence
does not supply those accounts or entitlements.

## Emitted runtime licences and retained notices

The local Wrangler 4.149.0 dry-run used the native Markdown Text and font Data
rules. Its `worker/.tmp/oss-dependency-bundle/bundle-meta.json` attributes
nonzero output bytes to 30 dependency packages, plus the separately compiled
TypeScript 5.9.3 parser. The accompanying `index.js` and source map are retained
locally for review; later source changes require a fresh build.

The table retains the upstream copyright notices for those packages. The MIT
permission and warranty text in [LICENSE](../../LICENSE) accompanies the MIT
rows under their own copyright notices; Forge's copyright covers Forge alone.
ISC and BSD terms follow the table. Installed package licence files remain the
source for exact wording. `@cfworker/json-schema` and `partyserver` omit their
licence file in npm; the linked immutable repository licences supply them.
`isarray` carries its MIT notice in `README.md`.

| Emitted package | Version | Licence and upstream copyright notice |
|---|---|---|
| `@babel/runtime-corejs3` | 7.29.10 | MIT; Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| `@cfworker/json-schema` | 4.1.1 | MIT; [Copyright (c) 2020 Jeremy Danyow](https://github.com/cfworker/cfworker/blob/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md) |
| `@lezer/common` | 1.5.4 | MIT; Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| `@lezer/highlight` | 1.2.5 | MIT; Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| `@lezer/markdown` | 1.6.3 | MIT; Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT; Copyright (c) 2024 Anthropic, PBC |
| `@shopify/liquid-html-parser` | 2.10.0 | MIT; Copyright 2022-present, Shopify Inc. |
| `agents` | 0.17.3 | MIT; Copyright (c) 2025 Cloudflare, Inc. |
| `ajv` | 8.20.0 | MIT; Copyright (c) 2015-2021 Evgeny Poberezkin |
| `ajv-formats` | 3.0.1 | MIT; Copyright (c) 2020 Evgeny Poberezkin |
| `content-type` | 1.0.5 | MIT; Copyright (c) 2015 Douglas Christopher Wilson |
| `core-js-pure` | 3.51.0 | MIT; Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru); Copyright (c) 2025–2026 CoreJS Company (core-js.io) |
| `cron-schedule` | 6.0.0 | MIT; Copyright (c) 2020 Pascal Sthamer |
| `eventsource` | 3.0.7 | MIT; Copyright (c) EventSource GitHub organisation |
| `eventsource-parser` | 3.1.1 | MIT; Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com> |
| `fast-deep-equal` | 3.1.3 | MIT; Copyright (c) 2017 Evgeny Poberezkin |
| `fast-uri` | 3.1.9 | BSD-3-Clause; Copyright (c) 2011–2021 Gary Court; Copyright (c) 2021–present The Fastify team; full notice below |
| `isarray` | 1.0.0 | MIT; Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com&gt; |
| `isobject` | 2.1.0 | MIT; Copyright (c) 2014-2016, Jon Schlinkert. |
| `json-schema-traverse` | 1.0.0 | MIT; Copyright (c) 2017 Evgeny Poberezkin |
| `line-column` | 1.0.2 | MIT; Copyright (c) 2016 IRIDE Monad <iride.monad@gmail.com> |
| `mime-db` | 1.52.0 | MIT; Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `mime-types` | 2.1.35 | MIT; Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| `mimetext` | 3.0.28 | MIT; Copyright (c) 2019 Murat Gözel |
| `nanoid` | 5.1.16 | MIT; Copyright 2017 Andrey Sitnik <andrey@sitnik.es> |
| `partyserver` | 0.5.10 | ISC; [Copyright 2024 Sunil Pai <spai@cloudflare.com>](https://github.com/cloudflare/partykit/blob/53f0c6819bd534d80152c6a1b324cd17c9ab4e6d/LICENSE) |
| `pkce-challenge` | 5.0.1 | MIT; Copyright (c) 2019 |
| `yaml` | 2.9.0 | ISC; Copyright Eemeli Aro <eemeli@gmail.com> |
| `zod` | 4.6.6 | MIT; Copyright (c) 2025 Colin McDonnell |
| `zod-to-json-schema` | 3.25.2 | ISC; Copyright (c) 2020, Stefan Terdell |
| `typescript` browser parser | 5.9.3 | Apache-2.0; Copyright (c) Microsoft Corporation; `LICENSE.txt` and `ThirdPartyNoticeText.txt` |

The emitted graph excludes Express, Hono, proxy-addr, body-parser, qs,
ip-address, Vite, Vitest, Wrangler, Miniflare, Sharp/libvips, lightningcss and
caniuse-lite. Their presence in the installed dependency graph still matters
for local tools. The all-dependency licence inventory includes MPL-2.0
(lightningcss), CC-BY-4.0 (caniuse-lite), and LGPL-3.0-or-later
(`@img/sharp-libvips-darwin-arm64`), alongside MIT, ISC, BSD, Apache and CC0.
The installed macOS arm64 inventory does not certify every optional platform
binary or its embedded native libraries.

Source publication ships package references and this register; a frozen
self-host install retrieves upstream packages and their notices. A separately
redistributed compiled Worker must also carry the complete TypeScript
[Apache licence](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt)
and [third-party notices](https://github.com/microsoft/TypeScript/blob/v5.9.3/ThirdPartyNoticeText.txt),
including applicable DefinitelyTyped/Unicode notices, alongside these retained
runtime notices. Keep those two upstream files unchanged from the installed
5.9.3 package; their contents are not duplicated here. The bundle's automatic
legal-comment footer covers only some components and is not a complete notice
pack. Packaging `node_modules`, native tools or a container needs its own
redistribution check. The bundled Onest font retains its separate SIL Open Font
License in [the font assets](../../worker/assets/fonts/OFL.txt).

### ISC terms

These terms accompany the upstream notices for `yaml`, `partyserver` and
`zod-to-json-schema` in the table above:

```text
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### fast-uri BSD-3-Clause notice

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```
