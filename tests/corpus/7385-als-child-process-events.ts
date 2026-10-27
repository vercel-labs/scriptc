// AsyncLocalStorage contexts of node:child_process events. A child's
// 'spawn', 'error', 'exit' and 'close' events and its stdout and stderr
// 'data' and 'end' events run in the context of the spawn() call,
// whatever context registered the listener or killed the child. stdin's
// 'finish' runs in the context of the end() call, and its 'drain' and
// 'error' in the context of the write() call. Lines are sorted at the end:
// the stdout and stderr events of one child may interleave.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

const store = new AsyncLocalStorage<string>();
const lines: string[] = [];
const log = (what: string): void => {
  lines.push(`${what}: ${store.getStore() ?? "none"}`);
};
const step = (fn: (done: () => void) => void): Promise<void> =>
  new Promise<void>((resolve) => fn(resolve));

await step((done) => {
  const child = store.run("spawn", () => spawn("/bin/sh", ["-c", "printf out; printf err >&2"]));
  store.run("listen", () => {
    child.on("spawn", () => log("spawn event"));
    child.stdout!.on("data", () => log("stdout data"));
    child.stdout!.on("end", () => log("stdout end"));
    child.stderr!.on("data", () => log("stderr data"));
    child.on("exit", () => log("exit"));
    child.on("close", () => {
      log("close");
      done();
    });
  });
});

await step((done) => {
  const child = store.run("spawn-cat", () => spawn("/bin/cat"));
  child.stdout!.on("data", () => log("cat data"));
  store.run("stdin-write", () => {
    child.stdin!.write("x");
  });
  child.stdin!.on("finish", () => log("stdin finish"));
  store.run("stdin-end", () => {
    child.stdin!.end();
  });
  child.on("close", () => {
    log("cat close");
    done();
  });
});

await step((done) => {
  const child = store.run("spawn-missing", () => spawn("/nonexistent/command"));
  child.on("error", () => log("spawn error"));
  child.on("close", () => {
    log("missing close");
    done();
  });
});

await step((done) => {
  const child = store.run("spawn-sleep", () => spawn("/bin/sleep", ["5"]));
  child.on("exit", () => log("killed exit"));
  child.on("close", () => {
    log("killed close");
    done();
  });
  setTimeout(() => store.run("kill", () => child.kill()), 20);
});

// A write that fills the pipe: 'drain' runs in the write() call's context.
await step((done) => {
  const child = store.run("spawn-slow", () =>
    spawn("/bin/sh", ["-c", "sleep 0.2; cat > /dev/null"]),
  );
  child.stdin!.on("drain", () => {
    log("stdin drain");
    child.stdin!.end();
  });
  child.on("close", () => {
    log("slow close");
    done();
  });
  store.run("large-write", () => {
    child.stdin!.write(Buffer.alloc(1 << 22, 97));
  });
});

// A write to a child that closed its stdin: 'error' runs in the write()
// call's context.
await step((done) => {
  const child = store.run("spawn-closed", () => spawn("/bin/sh", ["-c", "exec 0<&-; sleep 0.1"]));
  child.stdin!.on("error", () => log("stdin error"));
  child.on("close", () => {
    log("closed close");
    done();
  });
  setTimeout(() => {
    store.run("late-write", () => {
      child.stdin!.write(Buffer.alloc(1 << 20, 97));
    });
  }, 50);
});

lines.sort();
for (const line of lines) console.log(line);
