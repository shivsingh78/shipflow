# Self-hosted fonts

The dashboard's Content-Security-Policy only allows fonts from its own origin
(`font-src 'self'`), so no font CDN is used. Files here are served at `/ui/fonts/`.

| File | Family | Source | License |
|---|---|---|---|
| `inter-latin.woff2` | Inter (variable, weights 100-900, latin) | `@fontsource-variable/inter` 5.3.0 | SIL OFL 1.1: `OFL-Inter.txt` |
| `ibm-plex-mono-latin-{400,500,600}.woff2` | IBM Plex Mono (latin) | `@fontsource/ibm-plex-mono` 5.3.0 | SIL OFL 1.1: `OFL-IBM-Plex-Mono.txt` |

The OFL permits redistribution with the font files, provided the license text
travels with them. Do not rename or sell the fonts on their own.
