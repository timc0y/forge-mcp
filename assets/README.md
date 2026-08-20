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

The same path is compiled into `worker/src/ui.ts` as `forgeGlyph()`, so the site
and the avatar are one mark rather than two that drifted.
