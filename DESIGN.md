---
name: Forge
description: Implemented public reading and marketing styles, with the retained operational shell.
colors:
  primary: "#2349e8"
  primary-deep: "#1835ad"
  primary-wash: "#edf1ff"
  paper: "#fff"
  panel: "#f5f6f8"
  ink: "#202526"
  muted: "#575f62"
  line: "#e1e5e6"
  operate-panel: "#f7f7f8"
  operate-ink: "#0d0d0d"
  operate-muted: "#6e6e80"
  operate-line: "#e5e5e5"
  operate-dark-bg: "#0d0d0d"
  operate-dark-panel: "#161616"
  operate-dark-ink: "#ececf1"
  operate-dark-muted: "#9a9aa6"
  operate-dark-line: "#2a2a2a"
  success: "#0f7a3d"
  success-bg: "#eaf7ef"
  error: "#c02626"
  error-bg: "#fdeceb"
  success-dark: "#4ade80"
  success-dark-bg: "#10231a"
  error-dark: "#f87171"
  error-dark-bg: "#2a1414"
typography:
  display:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3rem,6.1vw,5.6rem)"
    fontWeight: 500
    lineHeight: 1.06
    letterSpacing: "-.04em"
  display-mobile:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.6rem,9.5vw,4rem)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-.04em"
  headline:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem,3.8vw,3.2rem)"
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: "-.035em"
  docs-title:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-.035em"
  docs-heading:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.55rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-.035em"
  body:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  docs-body:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: ".94rem"
    fontWeight: 400
    lineHeight: 1.75
  operate-body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: ".85rem"
    lineHeight: 1.5
rounded:
  public-control: "7px"
  sheet: "8px"
  public-panel: "12px"
  docs-navigation: "5px"
  operate-control: "10px"
  operate-panel: "14px"
spacing:
  gap: "1rem"
  sheet-gap: "1.5rem"
  docs-section: "3rem"
  operate-panel: "1.25rem"
components:
  button-public-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.public-control}"
    padding: ".7rem 1.15rem"
  button-public-primary-hover:
    backgroundColor: "{colors.primary-deep}"
  button-operate-primary:
    backgroundColor: "{colors.operate-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.operate-control}"
    padding: ".55rem 1.05rem"
  button-operate-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.operate-ink}"
    rounded: "{rounded.operate-control}"
    padding: ".55rem 1.05rem"
  badge-operate:
    backgroundColor: "{colors.operate-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.public-panel}"
    padding: "0 .45rem"
    height: "24px"
  navigation-docs-current:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.primary}"
    rounded: "{rounded.docs-navigation}"
    padding: ".55rem .7rem"
  sheet-document:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
  card-operate:
    backgroundColor: "{colors.operate-panel}"
    textColor: "{colors.operate-ink}"
    rounded: "{rounded.operate-panel}"
    padding: "{spacing.operate-panel}"
---

# Design System: Forge

## Overview

**Creative North Star: "The review folio"**

The public build reads as a generous white sheet with strong Onest headings,
blue actions and clearly separated conversation and document examples. “Review
folio” comes from the [surface brief](./.impeccable/surfaces/worker-src-landing-ts.md).
The descriptions here are inferences from the finished form, not a record of
user approval or a permanent aesthetic commitment.

Public marketing and documentation share this treatment. The original operational
shell retains system typography and the reader’s light/dark setting. Both use the
existing anvil and Forge wordmark required by [PRODUCT.md](./PRODUCT.md).
Homepage composition belongs to its surface brief; it is not a template for every page.

**Key Characteristics:**

- White public surfaces, blue actions and restrained grey dividers.
- Medium-weight Onest headings with close letter spacing.
- Reading layouts distinct from the compact operational shell.

Implementation owners: [public styles and docs](./worker/src/public-site.ts),
[homepage](./worker/src/landing.ts), and [shared shell](./worker/src/ui.ts).
Verification and deployment are recorded in [operations](./docs/operating-forge.md).

## Colors

### Primary

- **Annotation blue** (`primary`): public calls to action, links, selected docs
  navigation and the homepage folio. **Deep blue** (`primary-deep`) is the button
  hover state; **blue wash** (`primary-wash`) identifies the current docs page.

### Secondary

- **Success and error** (`success*`, `error*`): operational feedback foregrounds
  and backgrounds, with separate dark variants. These are status colors, not
  additional public brand accents.

### Neutral

- **White paper, pale panel, charcoal ink, muted grey and divider grey** (`paper`,
  `panel`, `ink`, `muted`, `line`): public backgrounds, body hierarchy and rules.
- **Operational neutrals** (`operate-*`): the retained shell’s light/dark values.
  Light mode shares white paper; its ink also supplies the dark background.

Sidecar tonal ramps are generated swatches, not additional implementation tokens.

**The Surface Theme Rule.** Public pages stay light; operational pages follow the
system color scheme. Apply each surface’s palette together.

## Typography

Public display and body use the locally served variable Onest, with the fallback
stack recorded above. Operational body text keeps its native system stack;
paths and code use the monospace stack. Exact role values live in frontmatter.

- **Display / mobile display:** homepage proposition; the mobile role applies
  at the public mobile breakpoint.
- **Headline:** repeated homepage section headings. The boundary panel has a
  smaller local heading treatment rather than another global role.
- **Docs title / heading:** document title and second-level headings. Mobile
  sizes step down to (2rem) and (1.4rem), respectively.
- **Body / docs body:** the public paragraph baseline and article container.
  Docs paragraphs inherit the public paragraph line height; the article’s own
  line height remains useful for other content. Mobile article text is (.91rem).
- **Operate body / mono:** compact task content and repository addresses.

Small example annotations are not a reusable text hierarchy. Component previews
use the recorded fallback when Onest has not been loaded by their host.

## Layout

The public container is capped at (82rem), with total horizontal allowance of
(5rem); mobile uses (2.5rem). The header is (92px) tall, reducing to (78px).
The homepage uses paired columns and ruled rows, then stacks them at (760px).
Its major work section has (6.5rem) vertical padding, reducing to (4rem).

Docs use navigation, article and contents columns: (178px), flexible centre and
(166px), separated by (3.5rem). The article is capped at (72ch). At (1150px) and
below, the right contents column becomes an “On this page” disclosure above the
article, while the left navigation remains. At (760px) and below, the left rail
also becomes a separate disclosure. Contents are derived from second-level
headings. Tables and code blocks scroll within their own containers.

The operational container is capped at (52rem). Its action rows stack at (640px).
Spacing keys above index repeated values; the implementation remains ordinary
CSS strings, without a generated token stylesheet or component framework.

## Elevation & Depth

Resting surfaces have no box shadow. Borders, pale backgrounds and nested white
sheets establish depth. The receipt alone briefly highlights with a blue tint
and soft shadow; the sidecar records its exact animation and shadow. This runs
once (850ms) only when reduced motion is not requested. Control background and
border transitions run for (140ms); reduced motion removes transitions and animation.

## Shapes

Controls and sheets have modest rounded corners, with role values in frontmatter.
The homepage folio and boundary panel share the public panel radius; the folio
reduces to (9px) on mobile. Operational panels are slightly rounder. Rules and
control borders use a thin (1px) stroke. The shared anvil is an inline SVG using
the current text color; its public presentation removes the operational mark’s
bordered box. The asymmetric conversation bubble is an example-specific shape.

## Components

### Buttons

Public primary links are blue, with white text and a minimum height of (48px).
Hover deepens the blue; active moves down (1px). Public focus uses a (2px) blue
outline offset by (4px). Operational buttons have a minimum height of (44px):
solid ink for primary, a bordered page-colored surface for secondary. Primary
hover lowers opacity to (.88); secondary hover uses the panel background.
Operational focus uses the current theme’s ink outline with a (2px) offset.

### Cards / Containers

The white document sheet, blue folio and pale boundary panel are public patterns.
Operational cards use a thin border and the operational panel background; success
and error sections substitute their status border and background. They remain
flat at rest. The sidecar records the document sheet with its native diff disclosure
rather than inventing a card API.

### Navigation

Public navigation pairs the anvil/wordmark with Docs, GitHub and the setup action;
the setup action disappears from the header on mobile. Docs navigation identifies
the current page with blue text and blue wash. Mobile navigation and contents use
native details/summary disclosures with minimum (44px) interaction heights. The
contents disclosure survives the intermediate width where only the right rail hides.

### Badges and fields

The operational badge is an ink-filled count pill. No styled input component is
defined in these three source files: only caret color is set, so there is no
invented field style or field preview here.

### Conversation / document example

The homepage shows two complete sheets, stacked on mobile. The document’s diff
is an actual disclosure. “Illustrative example” remains visible; the receipt is
example content. Use the existing anvil SVG rather than a substitute glyph.

## Do's and Don'ts

### Do

- Do keep public light styling and operational system themes distinct.
- Do preserve the shared anvil silhouette and Forge wordmark.
- Do keep mobile docs navigation and section contents separately available.
- Do retain visible keyboard focus and reduced-motion behavior.

### Don't

- Don't turn the homepage’s paired-sheet composition into a requirement for every surface.
- Don't treat the provisional review folio as a permanent user-approved aesthetic.
- Don't present illustrative receipts or local screenshots as proof of live product behavior.
