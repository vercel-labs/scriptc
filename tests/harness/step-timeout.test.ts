import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { runStep } from "./step-timeout.js";

describe("step deadlines", () => {
  test("a step that outlives its deadline names itself and the child it left running", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    let pid = 0;
    const failure = await runStep(
      "case.ts: node oracle",
      async (track) => {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        track(child);
        pid = child.pid!;
        await new Promise<never>(() => {});
      },
      100,
    ).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("case.ts: node oracle: no result after 100 ms");
    expect(message).toContain(`pid ${pid} `);
    // The deadline kills what the step left behind, since nothing awaits it.
    if (child!.exitCode === null && child!.signalCode === null) await once(child!, "exit");
    expect(child!.signalCode).toBe("SIGKILL");
  });

  test("a step that outlives its deadline with no processes says so", async () => {
    await expect(
      runStep("case.ts: compile (dev)", () => new Promise<never>(() => {}), 50),
    ).rejects.toThrow(/no result after 50 ms; no process remains under the test/);
  });

  test("a step that finishes returns its result and leaves no deadline behind", async () => {
    await expect(runStep("case.ts: run (release)", async () => 7, 50)).resolves.toBe(7);
  });
});
