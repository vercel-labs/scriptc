// ── one process.stdout.write for the program and its islands ───────────
// scripts/node-island-host.mjs appends this file to the bootstrap of
// programs that hold a process output stream as a value (the
// SCR_NODE_ISLAND_STDIO build of scr_node_island.c), so it runs in the
// bootstrap's scope. Every other program's bootstrap ends before it.
//
// Such a program can replace process.stdout.write or process.stderr.write,
// and in Node there is one stream, so a replacement sees every write of the
// program. Here the program's stream object and this Node's process.stdout
// are two objects over one descriptor. The program's write slot is the only
// one: `write` on this Node's two output streams is an accessor over it, so
// island code reads, calls and replaces the write the program reads, calls
// and replaces (scr_node_island_stdio.c holds the other half).
//
// - A function the program holds in the slot (its own write method, or a
//   replacement the program installed) reads here as one island function
//   per program function, which calls it with the program's stream as
//   `this` and the arguments as passed: console's (string, handler) pair,
//   byte chunks, an encoding, a callback.
// - A function island code assigns is called by the program's writes with
//   this Node's stream as `this` (`invoke` below), and reads back here as
//   itself.
//
// The accessor is an own property that cannot be reconfigured: `delete
// process.stdout.write` and Object.defineProperty(process.stdout, "write",
// ...) would otherwise leave island code with a write the program never
// sees, so they fail with V8's TypeError instead.
// oxlint-disable-next-line no-undef -- islandHelpers is scr_node_island_host.cjs's, which this file is appended to
islandHelpers.shareStdio = function shareStdio(slotGet, slotSet, slotCall) {
  const streams = [undefined, process.stdout, process.stderr];
  const forwarders = new WeakMap(); // program function -> its island function
  const programs = new WeakMap(); // and back
  const assigned = new WeakSet(); // functions island code put in the slot

  function forwarder(program) {
    let fn = forwarders.get(program);
    if (fn === undefined) {
      fn = function () {
        const fd = this === streams[1] ? 1 : this === streams[2] ? 2 : 0;
        return slotCall(program, fd, ...arguments);
      };
      Object.defineProperty(fn, "name", { value: program.name, configurable: true });
      Object.defineProperty(fn, "length", { value: program.length, configurable: true });
      forwarders.set(program, fn);
      programs.set(fn, program);
    }
    return fn;
  }

  for (const fd of [1, 2]) {
    Object.defineProperty(streams[fd], "write", {
      configurable: false,
      enumerable: false,
      get() {
        const value = slotGet(fd);
        if (typeof value !== "function" || assigned.has(value)) return value;
        return forwarder(value);
      },
      set(value) {
        const program = programs.get(value);
        if (program !== undefined) {
          slotSet(fd, program);
          return;
        }
        if (typeof value === "function") assigned.add(value);
        slotSet(fd, value);
      },
    });
  }

  // A program write reaching a function island code assigned.
  return function invoke(fn, fd, ...args) {
    return Reflect.apply(fn, streams[fd], args);
  };
};
