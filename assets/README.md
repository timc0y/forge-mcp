# Assets

One mark, three files. The anvil is a single silhouette with no strokes and no
curves, so it knocks out of any background and its profile survives being drawn
small — which is the only size a GitHub avatar is ever seen at in a list.

| File | Use |
|---|---|
| `forge-mark.svg` | The mark alone, `currentColor`. Embed it anywhere. |
| `forge-app-icon.svg` · `-512.png` · `-1024.png` | GitHub App avatar. Dark tile. |
| `forge-app-icon-light.svg` · `-512.png` · `-1024.png` | Same, for dark surroundings. |

Upload `forge-app-icon-512.png` at **Settings → Developer settings → GitHub Apps
→ forge-mcp-cloud → Display information**. GitHub accepts PNG and rounds the
corners itself; the tile already carries its own radius so it survives either
way.

It is also served, so there is a stable URL for a favicon, a link unfurler, and
anyone who needs the file without cloning:

| URL | |
|---|---|
| `https://timcoy.uk/forge/icon.png` | 512×512, dark tile |
| `https://timcoy.uk/forge/icon-light.png` | 512×512, light tile |
| `https://timcoy.uk/forge/favicon.svg` | the glyph alone, no tile |

The same path is compiled into `worker/src/ui.ts` as `forgeGlyph()`, so the site,
the favicon, the social card and the GitHub App avatar are one mark rather than
four that drifted.
