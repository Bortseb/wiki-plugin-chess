# Third-Party Notices

Federated Wiki Chess (`wiki-plugin-chess`) is licensed under **MIT** (see [`LICENSE`](./LICENSE)).
This file records the copyrights and license terms for third-party material **redistributed**
with the plugin (npm package `client/` tree, including built JavaScript bundles and assets).

Interactive credit and upstream links also appear in **Attributions and Thanks** in
[`client/index.html`](./client/index.html).

---

## MIT License

The following components are licensed under the MIT License:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

| Component                                 | Version                 | Copyright / attribution                                    |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| Bootstrap                                 | 5.3.x                   | Copyright 2011–2024 The Bootstrap Authors                  |
| bootstrap-auto-dark-mode                  | 1.1.x                   | Copyright Stefan Haack (https://shaack.com)                |
| chess-console                             | 6.14.x                  | Copyright Stefan Haack (https://shaack.com)                |
| chess-console-stockfish                   | 6.4.x                   | Copyright Stefan Haack (https://shaack.com)                |
| cm-chessboard                             | 8.12.x                  | Copyright Stefan Haack (https://shaack.com)                |
| cm-engine-runner                          | 2.0.x                   | Copyright Stefan Haack (https://shaack.com)                |
| cm-fen-editor                             | 3.2.x                   | Copyright Stefan Haack (https://shaack.com)                |
| cm-web-modules                            | 2.8.x                   | Copyright Stefan Haack (https://shaack.com)                |
| es-module-shims                           | 1.7.2                   | Copyright Guy Bedford and contributors                     |
| fzstd                                     | 0.1.x                   | Copyright Samuel Reed (bundled into `client/chess-app.js`) |
| jQuery (slim)                             | 3.3.1                   | Copyright JS Foundation and other contributors             |
| Transitive MIT deps bundled at build time | see `package-lock.json` | Respective authors per upstream `package.json`             |

Built/minified bundles (`client/chess.js`, `client/chess-app.js`, `client/cm-modules-bundle.js`,
`client/glicko-worker.js`) incorporate MIT-licensed code from the packages above. Esbuild is
configured with `legalComments: 'inline'` to preserve upstream `@license` comments where present.

---

## Font Awesome Free

**Package:** `@fortawesome/fontawesome-free` 6.7.x  
**Licenses:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
[SIL Open Font License 1.1](https://scripts.sil.org/OFL),
[MIT](https://github.com/FortAwesome/Font-Awesome/blob/6.x/LICENSE.txt)  
**Files:** `client/assets/styles/all.min.css`, `client/assets/chess/webfonts/*`  
**Attribution:** Icons by Font Awesome — https://fontawesome.com

---

## Stockfish (GPL-3.0)

**Package:** `stockfish` 18.x / stockfish.js  
**License:** [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)  
**Files:** `client/assets/js/stockfish-18-lite-single.js`,
`client/assets/js/stockfish-18-lite-single.wasm`  
**Upstream:** https://github.com/nmrugg/stockfish.js  
The shipped JavaScript file includes the GPLv3 license header. Stockfish is redistributed as
separate worker/WASM assets under GPL-3.0; it is not relicensed under MIT. The plugin’s original
code remains MIT; GPL obligations apply to the Stockfish components themselves.

---

## Chess piece graphics

Sprite files under `client/assets/pieces/` use separate licenses (not MIT). See the
**Chess Piece Sets** section in app attributions (`client/index.html`) and license
comments in each sprite file. Sets are packed from
[Lichess `public/piece`](https://github.com/lichess-org/lila/tree/master/public/piece);
thanks to [Lichess](https://github.com/lichess-org/lila/tree/master/public/piece) for hosting and curating them. Upstream
license exceptions are recorded in
[lila `COPYING.md`](https://github.com/lichess-org/lila/blob/master/COPYING.md).

| Set        | License           | Author / attribution                | Source                                                                  |
| ---------- | ----------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| Merida     | GPL-2.0-or-later  | Armando Hernandez Marroquin         | https://github.com/lichess-org/lila/tree/master/public/piece/merida     |
| Celtic     | MIT               | Maurizio Monge                      | https://github.com/lichess-org/lila/tree/master/public/piece/celtic     |
| Cburnett   | GPL-2.0-or-later  | Colin M. L. Burnett                 | https://github.com/lichess-org/lila/tree/master/public/piece/cburnett   |
| Chessnut   | Apache-2.0        | Alexis Luengas                      | https://github.com/lichess-org/lila/tree/master/public/piece/chessnut   |
| Kiwen Suwi | CC BY 4.0         | neverRare                           | https://github.com/lichess-org/lila/tree/master/public/piece/kiwen-suwi |
| Kosal      | AGPL-3.0-or-later | lila authors (default Lila license) | https://github.com/lichess-org/lila/tree/master/public/piece/kosal      |
| mpchess    | GPL-3.0-or-later  | Maxime Chupin                       | https://github.com/lichess-org/lila/tree/master/public/piece/mpchess    |
| Pixel      | AGPL-3.0-or-later | therealqtpi                         | https://github.com/lichess-org/lila/tree/master/public/piece/pixel      |
| Shapes     | CC BY-SA 4.0      | flugsio                             | https://github.com/lichess-org/lila/tree/master/public/piece/shapes     |

**Apache-2.0 (Chessnut):** Licensed under the Apache License, Version 2.0 —
https://www.apache.org/licenses/LICENSE-2.0

---

## Data and sounds

| Material                     | License   | Notes                                           |
| ---------------------------- | --------- | ----------------------------------------------- |
| Lichess open puzzle database | CC0       | Puzzle positions/ratings (see app attributions) |
| chess_console_sounds.mp3     | CC BY 4.0 | chess-console asset pack                        |

---

## Development-only dependencies

Packages used only to build, test, or lint (for example `esbuild`, `eslint`, `prettier`, `sass`)
are listed in `package.json` / `package-lock.json` and are **not** redistributed in the published
plugin package except as reflected in built artifacts above.
