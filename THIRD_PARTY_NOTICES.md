# Third-party notices

Arki's original code is licensed under [MIT](LICENSE). Third-party components keep their own licenses.

| Component | Use | License / source |
| --- | --- | --- |
| React Flow (`@xyflow/react`) | Interactive component canvas | MIT · [xyflow/xyflow](https://github.com/xyflow/xyflow) |
| ELK.js | Nested component layout | EPL-2.0 · [kieler/elkjs](https://github.com/kieler/elkjs); used without modification |
| Archify | Vendored compatibility renderer | MIT · [license](third_party/archify/LICENSE), [provenance and modifications](third_party/archify/NOTICE.md) |
| React, Vite, Zod, Vitest, Playwright and other packages | Application and development tooling | Respective package licenses; exact versions in `pnpm-lock.yaml` |

The production web bundle includes React Flow and ELK license text in `plugins/aimd-reader/dist/third-party-licenses.txt` and an embedded HTML template. Vendored Archify carries its original copyright and license. Build tools and dependencies are not relicensed by Arki's MIT license. Release archives preserve these notices.
