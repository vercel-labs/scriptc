# island-conformance fixture

Programs over widely used published packages, for the island conformance lane (`tests/harness/island-conformance.test.ts`). Each program in `programs/` runs under Node, as its default build, and once per imported package with that package forced into a Node island; the three must agree.

The vendored `node_modules` is committed test data on purpose: the lane must exercise the published packages, pinned to the versions in `package.json`. Each package keeps its own license file.

The packages are trimmed to what a build and Node read:

- documentation, source maps and `bin` directories are removed everywhere;
- `lodash` keeps `lodash.js` only, and `@types/lodash` keeps `index.d.ts` and `common/`;
- `date-fns` keeps its ES modules, their declarations and the `en-US` locale (of `fp/` only the types its declarations name, no CommonJS copies, no other locales, no `locale.js` and `fp.js` barrels);
- `yaml` keeps its Node build (`dist/`), not `browser/`.

`process-reader` is not a published package: it is the smallest package that reads `process` state (`argv`, `env`, `cwd`, `exitCode`, `stdout.isTTY`), so `programs/process-state.ts` can check that a package sees the program's process however it runs.

To bump a package: `npm install --ignore-scripts --save-exact <package>@<version>` in a scratch copy of this directory, apply the same trimming, and re-run the lane with `SCRIPTC_ISLAND_CONFORMANCE=update` (Node remains the oracle, so there are no golden files).
