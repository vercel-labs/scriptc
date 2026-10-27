# Split tools

These scripts split a large source file into smaller files without changing behavior, and carry open branches across the split. Each transform is deterministic: the same config gives the same result on any version of the tree, and rehoming depends on that.

Run them from a checkout with `node_modules` installed. That checkout is the tools directory (`--tools`) and supplies `typescript` and `oxfmt`.

## Transforms

- `split-module.mjs plan|apply <config>` moves top-level declarations into new files. `plan` computes a manifest from seed declarations, and `apply` does the move.
- `split-methods.mjs apply <config>` moves class methods into exported functions that take the instance as a parameter (`emitter`). The class keeps a one-line stub with the same signature, so callers don't change.
- `move-state.mjs apply <config>` moves a group of class fields into a feature's state object, defined in the feature's file with `defineModuleState` (`packages/compiler/src/backend/llvm/emitter-state.ts`). It rewrites `this.<field>` and `emitter.<field>` to `KEY.of(this).<field>` and creates files from templates. It also applies the change's other edits as literal replacements, in order. A replacement whose text isn't found the expected number of times is reported and skipped.

Each transform takes `--repo <dir>` (the tree to rewrite) and `--tools <dir>`, and formats what it writes with the tools checkout's oxfmt and its `.oxfmtrc.jsonc` (`format.mjs`). The formatter reads no configuration from `--repo`, so an `oxfmt.config.ts` a branch commits is never run. The tools read and write the tree's files only at real paths inside `--repo`, and a config's templates and manifest only inside the config's directory. A path that resolves elsewhere, through a symlink or `..`, stops the tool with an error (`confine.mjs`). `configs/` holds the configs of splits that have landed. For example, `configs/loop-state/` moves the loop optimizations' state out of `LlEmitter`.

## Rehoming an open branch

```sh
git fetch origin pull/<n>/head:pr-<n>
node scripts/split/rehome-split.mjs --branch pr-<n> --onto origin/main --config scripts/split/configs/<split>/<config>.json
```

The result is the branch `pr-<n>-rehomed`, a merge of `origin/main` into the branch.

The script applies the split's transform to the branch's merge base and to its tip, then cherry-picks the difference onto `--onto`. It records the result as a merge commit with parents (branch tip, `--onto`), so it can be pushed without rewriting the branch; `--squash` makes one ordinary commit instead. Conflicts made only of import lines in the split's files resolve to both sides' imports. Any other conflict stops the script, which lists the files and leaves its scratch worktree for you to resolve.
