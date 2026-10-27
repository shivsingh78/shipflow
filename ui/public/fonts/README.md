# Self-hosted fonts

The dashboard's Content-Security-Policy only allows resources from its own origin, so the
two typefaces are shipped here instead of being loaded from a font CDN.

| File | Family | Use | License |
|---|---|---|---|
| `sora-latin.woff2` | [Sora](https://fonts.google.com/specimen/Sora) (variable, latin subset) | headings, labels, numbers | SIL Open Font License 1.1 |
| `manrope-latin.woff2` | [Manrope](https://fonts.google.com/specimen/Manrope) (variable, latin subset) | body text | SIL Open Font License 1.1 |

Both are distributed under the SIL OFL 1.1 (https://openfontlicense.org), which permits
redistribution with the software. They are declared in `ui/src/styles/base.css`.
