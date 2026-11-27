# library-hostcall

Per-call cost of a `--lib` host-callback channel. `lib.ts` exports `run(n)`, a loop of `n` synchronous `tick(i)` channel calls; `probe.c` registers the channel and times that export against a direct, `noinline` C function called in the same loop with the same counter argument. The counter is a proven whole number below 2^31 (the loop bound is ToInt32'd first), so the measurement covers the `u32` argument conversion as well as the dispatch.

`profile.json` builds a classic library; `profile-thread.json` builds a thread-instanced one (`abi.instance_per_thread`), where the state lives in thread-local storage.

Each run prints raw nanoseconds for both loops, alternating which goes first, so the runner reports ns per call and a before/after 95% interval across repetitions.

```bash
node benchmarks/library-hostcall/run.mjs measure --out /tmp/before.json --reps 9
node benchmarks/library-hostcall/run.mjs measure --out /tmp/before-thread.json --reps 9 \
  --profile profile-thread.json
# rebuild the compiler and runtime pack for the change, then run both again as
# /tmp/after.json and /tmp/after-thread.json, and compare each pair:
node benchmarks/library-hostcall/run.mjs compare /tmp/before.json /tmp/after.json
```

The runner builds the fixture with the checkout's own compiler and runtime pack and disables the build cache, so it measures the tree it is run from. It links the probe with `clang -O2`.
