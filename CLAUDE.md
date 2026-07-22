## Graphify task startup

Every primary agent and subagent must do this before reading source or starting a task:

1. Activate Caveman ultra mode (`/caveman ultra`).
2. Run `npm run graphify:refresh` from the repository root. It incrementally rebuilds the local AST graph, refreshes every community label from the current code paths, and regenerates `graphify-out/GRAPH_REPORT.md` without API cost.
3. Read `graphify-out/GRAPH_REPORT.md`; use `graphify query`, `graphify path`, or `graphify explain` before broad raw-file searches.

After changing code, run `npm run graphify:refresh` again. For docs, images, or other semantic inputs, run `/graphify . --update` instead. If Graphify is missing, install the official CLI once with `uv tool install graphifyy`. `graphify-out/` is local generated state and is intentionally not committed.
