// child.off()/removeListener() remove a listener by FUNCTION IDENTITY — the
// same const binding that was registered — and child.signalCode is the
// terminating signal's name: null while the child runs, after a normal
// exit, and after a spawn failure. The children run one after another
// (each spawned from the previous exit handler) so the event order is
// pinned instead of racing.
import { spawn } from "node:child_process";

const removedExit = (code: number | null, signal: string | null): void => {
  console.log("removed exit fired", code, signal);
};
const removedClose = (code: number | null, signal: string | null): void => {
  console.log("removed close fired", code, signal);
};
const removedError = (error: Error): void => {
  console.log("removed error fired", error.message);
};
const removedSpawn = (): void => {
  console.log("removed spawn fired");
};

const clean = spawn("sh", ["-c", "exit 7"], { stdio: "ignore" });
console.log("running:", clean.signalCode, clean.signalCode === null);
clean.on("spawn", removedSpawn);
clean.on("exit", removedExit);
clean.on("close", removedClose);
clean.on("error", removedError);
clean.off("spawn", removedSpawn);
clean.off("exit", removedExit);
clean.removeListener("close", removedClose);
clean.removeListener("error", removedError);
clean.on("exit", (code, signal) => {
  console.log("kept exit:", code, `${signal}`, clean.signalCode === null, clean.exitCode);

  const killed = spawn("sh", ["-c", "kill -TERM $$"], { stdio: "ignore" });
  killed.on("exit", (code2, signal2) => {
    console.log("killed exit:", code2, `${signal2}`, `${killed.signalCode}`);
    console.log("killed match:", killed.signalCode === signal2, killed.exitCode === null);

    // A listener the registry never held removes nothing, and removing
    // the same listener twice is a no-op (Node's answer).
    const failed = spawn("scriptc-no-such-binary-for-corpus", [], { stdio: "ignore" });
    failed.on("error", (error) => {
      console.log("spawn failure:", error.name, failed.signalCode === null);
      failed.off("close", removedClose);
      failed.off("close", removedClose);
      console.log("done");

      // Node's emit COPIES the listener array before it delivers the
      // event, so a listener that removes a SIBLING must not cut the emit
      // in flight short: the removed listener still runs for this event.
      const exiting = spawn("sh", ["-c", "exit 9"], { stdio: "ignore" });
      const inFlightExit = (code: number | null, signal: string | null): void => {
        console.log("in-flight exit:", code, signal);
      };
      exiting.on("exit", (code, signal) => {
        exiting.off("exit", inFlightExit);
        console.log("remover exit:", code, signal);
      });
      exiting.on("exit", inFlightExit);
      const inFlightClose = (code: number | null, signal: string | null): void => {
        console.log("in-flight close:", code, signal);
      };
      exiting.on("close", (code, signal) => {
        exiting.off("close", inFlightClose);
        console.log("remover close:", code, signal);
      });
      exiting.on("close", inFlightClose);
    });
  });
});
console.log("main done");
