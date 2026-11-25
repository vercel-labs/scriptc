# Start-up benchmarks

Programs whose time to exit is what a start costs before the entry point's first statement. They are workloads of the runtime benchmark set (`benchmarks/runtime/workloads/startup-*.json`, category `startup`), so `pnpm bench:runtime` times them per launch against a baseline checkout and against Node.js, and the zero-cost gate compiles them with both checkouts.

## modules/

A program of 240 small typed modules and an entry that imports them all and prints one line. Nothing runs after the modules have, so the time is module initialization. Each module's top level does one kind of work that application modules do at load: a class with a static member and instances, a `Map` filled at load and handlers added to a shared registry, a table of records, strings built from imported constants and regex literals, a constant object and a `Set`, closures over module state. Every sixteenth module also builds a regular expression from a string, with a Unicode property class. The modules import lower-numbered modules, so the import graph is a chain with shortcuts.

The files are generated and checked in:

```console
$ node benchmarks/startup/generate.mjs
$ node benchmarks/startup/generate.mjs --check
```

Change the generator, not the files.

## islands/

A command-line program with three dependencies in Node islands, for the `startup-islands-*` workloads; its row in `benchmarks/runtime/README.md` describes it. Those workloads need a libnode pack (`requires` in the same README).

## unused/

A command-line tool of four modules that build their tables when they load: number tables filled by loops, a table of records derived from a smaller one, a catalogue of groups flattened into rows with `Object.entries` and `flatMap`, and regular expressions assembled from strings. Its `--version`, which the `startup-unused-tables` workload runs, uses none of them, so the time to exit is what tables nobody reads cost a start. `check` uses each table once and prints one line.
