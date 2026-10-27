# Per-program corpus costs

A change that adds a corpus program, or changes how long one takes, records the program's CI cost here instead of editing `../corpus-costs.json`: one file per program, named after it, with the milliseconds of its differential plus llvm-differential case per flavor.

```json
{ "plain": 2700, "san": 3200 }
```

`5637-child-max-buffer-sync.ts` goes in `5637-child-max-buffer-sync.ts.json`, and a directory program such as `2946-child-fork-ipc/main.ts` in `2946-child-fork-ipc/main.ts.json`. Either flavor may be left out. These files override the table for shard balancing (`tests/harness/shard.ts`), and `scripts/ci-corpus-costs.mjs` folds them into the table and deletes them when it refreshes the costs from CI logs. Separate files keep changes that add programs from editing the same lines of the table.
