# Fonturi

Fonturile sunt în repository și se încarcă prin `next/font/local`, deci build-ul (inclusiv cel din Docker) nu are nevoie de internet și nimic nu se servește de pe un CDN. `next/font/google` ar fi descărcat fișierele la build, deci nu funcționa offline.

| Fișier | Sursă (github.com/google/fonts, ramura `main`) | Prelucrare |
|---|---|---|
| `bricolage-grotesque-var.woff2` | `ofl/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf` | axa `wdth` fixată la 100; axele `opsz` (12–96) și `wght` (200–800) păstrate |
| `ibm-plex-sans-var.woff2` | `ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf` | axa `wdth` fixată la 100; `wght` (100–700) păstrată |
| `ibm-plex-mono-400.woff2`, `ibm-plex-mono-600.woff2` | `ofl/ibmplexmono/IBMPlexMono-Regular.ttf`, `-SemiBold.ttf` | — |

Toate sunt reduse la Latin + Latin Extended (inclusiv ș, ț, ă, â, î cu virgulă: U+0218–U+021B) și convertite în WOFF2 cu fontTools 4:

```bash
U="U+0000-00FF,U+0100-02FF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2000-206F,U+20A0-20C0,U+2113,U+2122,U+2191,U+2193,U+2212,U+2215,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD"
fonttools varLib.instancer BricolageGrotesque[opsz,wdth,wght].ttf wdth=100 -o bric.ttf
fonttools varLib.instancer IBMPlexSans[wdth,wght].ttf wdth=100 -o plex.ttf
pyftsubset bric.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=bricolage-grotesque-var.woff2
# la fel pentru plex.ttf și IBMPlexMono-{Regular,SemiBold}.ttf
```

Licență: SIL Open Font License 1.1 (`OFL-BricolageGrotesque.txt`, `OFL-IBMPlex.txt`).
