// The optional-chain form of the ChildProcess members: `this.child?.kill()`
// and `this.child?.on(...)` reach the same lowerings as the plain calls, so
// an absent child is a no-op and a present one keeps Node's shapes.
import { spawn, type ChildProcess } from "node:child_process";

class Runner {
  child: ChildProcess | undefined;
  constructor(child: ChildProcess | undefined) {
    this.child = child;
  }
  kill(): void {
    this.child?.kill("SIGTERM");
    console.log("kill attempted, child present:", this.child !== undefined);
  }
  watch(): void {
    this.child?.on("exit", (code) => console.log("exit", code));
  }
}

const withChild = new Runner(spawn("sleep", ["5"], { stdio: "ignore" }));
withChild.watch();
withChild.kill();

const withoutChild = new Runner(undefined);
withoutChild.watch();
withoutChild.kill();
console.log("done");
