# Image Prompting Principles

## Core structure

Order prompt elements clearly from global context to local constraints:

1. **Intended use / asset type** (landing page hero, mobile UI mockup, product catalog photo, technical infographic)
2. **Scene / backdrop** (setting, environment, clean studio backdrop, flat neutral canvas)
3. **Subject** (main focal subject, action, proportions)
4. **Style / medium & camera** (photorealistic lens/angle, editorial illustration, clean vector-style graphic, 3D render)
5. **Lighting / color / materials** (key light, mood, surface finishes, palette roles)
6. **Exact verbatim text** (quoted strings + typography style + placement)
7. **Constraints & avoid list** (invariants for edits, no watermarks/logos, clean negative space)

## Specificity policy

- **When the user gives a detailed prompt:** keep every stated detail intact; only normalize layout and remove ambiguity. Do not inject unrequested characters, brand names, slogans, or extra props.
- **When the user gives a brief/generic prompt:** add only concrete details that directly improve output quality (composition/framing, lighting, medium, intended-use polish).

## Exact text rendering

- Put required on-image text in double quotes and state typography weight and placement clearly.
- Keep text minimal and high-contrast. For unusual spellings, spell tricky words out explicitly and require verbatim rendering.

## Multi-image & edit invariants

- Reference multiple `--image` inputs by 1-based index matching flag order (`Image 1: base product photo to edit; Image 2: lighting and marble surface reference`).
- State invariants explicitly in every edit prompt (`Change only the background to soft dawn light; keep the subject, label text, perspective, and edges unchanged`).
- Iterate with one focused edit per pass rather than piling unrelated changes into one regeneration.

## Use-case quick notes

- `photorealistic-natural`: candid framing, natural light, real textures, lens/depth-of-field cues; avoid overly polished studio look.
- `product-mockup`: clean studio backdrop, controlled shadows and reflections, generous margins, no unrequested logos.
- `ui-mockup`: realistic product UI hierarchy, readable labels, authentic layout rather than abstract concept art.
- `infographic-diagram` / `scientific-educational`: structured visual flow, clear arrows, short verbatim labels, generous whitespace.
- `logo-brand`: simple silhouette, flat colors, balanced negative space, centered on plain backdrop, original mark only.
- `precise-object-edit`: name the exact element to remove/replace and lock surrounding texture, lighting, and framing.
- `identity-preserve`: lock face, body, pose, expression, and hair; change only clothing/scene and match ambient shadows.
- `background-extraction`: request a clean cutout without halos or restyling; use `gpt-image-1.5` with `--background transparent --output-format png` only when confirmed for native alpha.

For ready-to-adapt prompt templates, see `references/sample-prompts.md`.
