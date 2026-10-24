# Node test/parallel files

`run.mjs` builds files from a Node.js checkout's `test/parallel` with scriptc, runs each executable in that directory, and compares its exit status with Node's. It records a verdict per file: `pass` (same exit status), `fail` (different exit status), or `refused` (the build failed), with the first error line.

```bash
git clone --depth 1 --branch v24.22.0 https://github.com/nodejs/node /path/to/node
node tests/node-parallel/run.mjs --node /path/to/node --pattern '^test-(url-|whatwg-url-|querystring)'
```

Options:

- `--node`: a Node.js checkout, or its `test` directory. Use the version in `.node-version`.
- `--pattern`: a regular expression over file names in `test/parallel`.
- `--common`: `minimal` (the default) or `node`.
  - `minimal` copies the selected files into `<out>/tree/test/parallel` and uses `common/index.cjs` and `common/wpt.cjs` from this directory as `test/common/index.js` and `test/common/wpt.js`, with the checkout's `test/fixtures` and `test/common/fixtures.js`. The minimal common has the helpers these files use (`mustCall`, `mustNotCall`, `skip`, `expectWarning`, `invalidArgTypeHelper`, `spawnPromisified`, `hasIntl`, `isWindows`, ...) with Node's semantics, so a verdict measures the module under test rather than Node's full `test/common`.
  - `node` builds the files in place against Node's own `test/common`.
- `--out`: where executables and results go (default `node_modules/.cache/scriptc-node-parallel`).
- `--cli`: the scriptc CLI entry (default `packages/cli/dist/main.js`).
- `--jobs`: concurrent files (default 4).

Node runs each file with its `// Flags:` line. Results are written to `<out>/results.json` and `<out>/results.md`.

Before a lane relies on the minimal common, run its files under Node in `<out>/tree/test/parallel`: they should all pass there.
