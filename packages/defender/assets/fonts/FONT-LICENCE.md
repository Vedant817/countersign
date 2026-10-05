# Font licence — `Roboto-Regular.ttf`

## What this file is

`Roboto-Regular.ttf` is embedded into every evidence packet PDF that
`packages/defender/src/evidence-doc.ts` renders, so the PDF renders identically on a developer's laptop,
in CI and on Render without any system font being present.

## The font

|              |                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Family       | Roboto Regular                                                                                             |
| Source       | `googlefonts/roboto-2`, `src/hinted/Roboto-Regular.ttf`                                                    |
| Licence      | **Apache License 2.0**                                                                                     |
| Licence text | `Roboto-LICENSE.txt`, in this directory, verbatim                                                          |
| Retrieved    | 2026-10-05                                                                                                 |
| SHA-256      | `56a45233d29f11b4dfb86d248e921939d115778f87325e7ae8cc108383d6664d` (pinned by `test/evidence-doc.test.ts`) |

Apache-2.0 is compatible with this repository's own licence (Apache-2.0, per the root `package.json`)
and permits redistribution inside a source tree. The NOTICE obligation is met by keeping
`Roboto-LICENSE.txt` beside the font.

## Why a font file is committed rather than fetched

Spec **§8.18** requires the packet PDF to be **reproducible**: the same packet renders byte-identical
output. A font fetched at build time breaks that in two ways — the bytes depend on the network, and
`pdf-lib`'s subsetter emits different glyph subsets depending on the font version that happened to
arrive. Relying on a _system_ font breaks it differently: Render's image does not have the same font
set as a developer's laptop, so the same packet would render with different metrics and different
bytes.

So the font is a committed input, like the pinned VI library commit in `@countersign/core`. The
`SHA-256` pin in the tests makes a silent font swap a test failure rather than a diff nobody notices.

## Why fontkit is required

`pdf-lib`'s built-in `StandardFonts` are the PDF base-14 fonts. They would avoid the font file, but
they are **WinAnsi**: `₹`, `€`, `£` and the typographic quotes the compiler's read-back uses
(`"`, `—`, `…`) are not encodable, so a read-back would silently lose characters on the one page a
judge reads. `@pdf-lib/fontkit` is what makes a real Unicode TTF embeddable, and
`evidence-doc.ts` additionally **pre-scans** every string it draws and refuses to render rather than
dropping a character (see `assertEncodable`).
