# Assets

Use the anvil mark for Forge. The simple shape stays legible at small sizes.

| File | Use |
|---|---|
| `forge-mark.svg` | The mark alone, `currentColor`. Embed it anywhere. |
| `forge-app-icon.svg` · `-512.png` · `-1024.png` | GitHub App avatar. Dark tile. |
| `forge-app-icon-light.svg` · `-512.png` · `-1024.png` | Same, for dark surroundings. |

Upload `forge-app-icon-512.png` at **Settings → Developer settings → GitHub Apps
→ your App → Display information**. GitHub accepts PNG and rounds the
corners itself; the tile already carries its own radius so it survives either
way.

It is also served, so there is a stable URL for a favicon, a link unfurler, and
anyone who needs the file without cloning:

| URL | |
|---|---|
| `<YOUR_FORGE_ORIGIN>/icon.png` | 512×512, dark tile |
| `<YOUR_FORGE_ORIGIN>/icon-light.png` | 512×512, light tile |
| `<YOUR_FORGE_ORIGIN>/favicon.svg` | the glyph alone, no tile |

The same path is compiled into `worker/src/ui.ts` as `forgeGlyph()`, so the site,
favicon, social card and GitHub App avatar use the same mark.

Public pages use the self-hosted Onest variable font. Its source and separate
SIL Open Font License are in [worker/assets/fonts](../worker/assets/fonts/README.md).
The shared visual tokens and responsive patterns are in [DESIGN.md](../DESIGN.md).
