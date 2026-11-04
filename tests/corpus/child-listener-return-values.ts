// A child-process listener's return value is dropped, as EventEmitter's
// emit drops it: an inferred value return, an annotated value return, and
// an async listener (whose promise Node never awaits). Each child is
// awaited before the next starts, so the print order is fixed and the
// differential run pins that returning a value changes nothing.
import { spawn } from "node:child_process";

function waitClose(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
}

async function main(): Promise<void> {
  const c1 = spawn("/bin/sh", ["-c", "exit 7"], { stdio: "ignore" });
  c1.on("exit", (code) => {
    console.log("inferred return", code === null ? "signal" : code);
    return code === null ? 0 : code;
  });
  await waitClose(c1);

  const c2 = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
  c2.on("exit", (): number => {
    console.log("annotated return");
    return 5;
  });
  await waitClose(c2);

  const c3 = spawn("/bin/sh", ["-c", "exit 3"], { stdio: "ignore" });
  c3.on("exit", () => console.log("sync exit listener"));
  c3.on("close", async (code) => {
    await Promise.resolve();
    console.log("async listener", code);
  });
  await waitClose(c3);

  // A value-returning listener registers through an adapter; removing the
  // original function removes it.
  const c4 = spawn("/bin/sh", ["-c", "exit 4"], { stdio: "ignore" });
  const removed = (code: number | null): number => {
    console.log("removed listener ran", code);
    return 1;
  };
  const kept = (code: number | null): number => {
    console.log("kept listener", code);
    return 2;
  };
  c4.on("exit", removed);
  c4.on("close", removed);
  c4.on("exit", kept);
  c4.off("exit", removed);
  c4.removeListener("close", removed);
  await waitClose(c4);

  console.log("main done");
}

void main();
