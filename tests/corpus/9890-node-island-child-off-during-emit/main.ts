// @requires-libnode
// A listener of a child process a Node island started removes a listener of the same event while
// the event is being emitted. Node calls every listener that was registered when the emit started:
// a later sibling an earlier one removes still runs in that emit and in no later one. Each line
// is three emits of 'spawn' (the child's own, then two the island makes), separated by "|".
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

async function scenario(name: string, arrange: (child: ChildProcess, log: string[]) => void): Promise<void> {
  const child: ChildProcess = lib.start();
  const log: string[] = [];
  arrange(child, log);
  await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
  log.push("|");
  lib.emitSpawn(child);
  log.push("|");
  lib.emitSpawn(child);
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.kill();
  await closed;
  console.log(`${name}: ${log.join(" ")}`);
}

async function main(): Promise<void> {
  await scenario("a later sibling", (child, log) => {
    const b = (): void => {
      log.push("b");
    };
    child.on("spawn", () => {
      log.push("a");
      child.off("spawn", b);
    });
    child.on("spawn", b);
    child.on("spawn", () => {
      log.push("c");
    });
  });
  await scenario("an earlier sibling", (child, log) => {
    const a = (): void => {
      log.push("a");
    };
    child.on("spawn", a);
    child.on("spawn", () => {
      log.push("b");
      child.off("spawn", a);
    });
  });
  await scenario("itself", (child, log) => {
    const a = (): void => {
      log.push("a");
      child.off("spawn", a);
    };
    child.on("spawn", a);
    child.on("spawn", () => {
      log.push("b");
    });
  });
  await scenario("removed and registered again", (child, log) => {
    const b = (): void => {
      log.push("b");
    };
    child.on("spawn", () => {
      log.push("a");
      child.off("spawn", b);
      child.on("spawn", b);
    });
    child.on("spawn", b);
  });
  await scenario("an emit inside the emit", (child, log) => {
    let calls = 0;
    const b = (): void => {
      log.push("b");
    };
    child.on("spawn", () => {
      log.push("a");
      child.off("spawn", b);
      if (++calls === 1) {
        log.push("(");
        lib.emitSpawn(child);
        log.push(")");
      }
    });
    child.on("spawn", b);
    child.on("spawn", () => {
      log.push("c");
    });
  });
  await scenario("removed before the emit", (child, log) => {
    const a = (): void => {
      log.push("a");
    };
    child.on("spawn", a);
    child.on("spawn", () => {
      log.push("b");
    });
    child.off("spawn", a);
  });
}
main();
