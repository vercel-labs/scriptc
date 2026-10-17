# Lifetime-region benchmarks

Programs that build generations of `ProgramLifetime` objects and free each generation with a `LifetimeRegion` (`@scriptc/experimental`). Every variant prints the same result line before its timings.

| Program | Shape |
| --- | --- |
| `generations.ts` | Per-file syntax trees and binder symbols in one region per file, checker state (types, signatures, node and symbol links in paged tables, literal and union caches) in one region per generation. `edit` re-parses one file per generation, `all` re-parses every file. |
| `compiler.ts` | A tokenizer, recursive-descent parser, binder and checker over generated sources, rebuilt from scratch in one region per build, like a watch mode that does not reuse syntax trees. |
| `emit.ts` | A large live graph of ordinary objects with parent links, standing in for a type checker, and a per-file emit that builds its output in a region released right after. |
| `requests.ts` | Batches of concurrent async request handlers, each in its own region across its awaits: tokenize a JSON body, parse it into a syntax tree that points at its tokens, validate it into issues and an index, render a response, release the region. |

```console
$ node benchmarks/regions/run.mjs --baseline=../scriptc-main --runs=7
```

Each configuration is timed in five variants, interleaved: `on` (ProgramLifetime classes, no regions), `off` (the same classes without `implements ProgramLifetime`), `region`, `region-plain` (the region build run without constructing a region, which measures what supporting regions costs a one-shot run) and Node.js. `--baseline` builds `on` and `off` with another checkout.
