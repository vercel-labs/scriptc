import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { abnormalExitMessage, runStep } from "./step-timeout.js";

/** Whether `pid` has ended, allowing a moment for a just-killed process to be
 * reaped. */
async function exited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

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

  test("a deadline stops processes a step starts without registering them", async () => {
    // A compile starts its LLVM helper itself, below the harness, so a
    // stalled compile leaves a process that no callback can name. Model it
    // with a child that starts its own child; neither is registered.
    const child = spawn(
      process.execPath,
      [
        "-e",
        'const { spawn } = require("node:child_process"); const h = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(h.pid); setInterval(() => {}, 1000);',
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const helper = await new Promise<number>((resolve) => {
      child.stdout!.once("data", (data: Buffer) => resolve(Number(data.toString("utf8").trim())));
    });
    const failure = await runStep(
      "case.ts: compile (dev)",
      () => new Promise<never>(() => {}),
      200,
    ).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`pid ${child.pid} `);
    expect(message).toContain(`pid ${helper} `);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    expect(child.signalCode).toBe("SIGKILL");
    expect(await exited(helper)).toBe(true);
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

describe("abnormal exits", () => {
  test("a signal death names the signal and quotes both streams", () => {
    const failure = Object.assign(new Error("Command failed: ./program\n"), {
      code: null,
      signal: "SIGSEGV",
      stdout: Buffer.from("a\nb\n"),
      stderr: Buffer.from(""),
    });
    const message = abnormalExitMessage("./program", failure);
    expect(message).toContain("./program did not exit normally (signal SIGSEGV, code null)");
    expect(message).toContain('stdout "a\\nb\\n"');
    expect(message).toContain('stderr ""');
  });

  test("a long stream is cut to its head and names its full size", () => {
    const message = abnormalExitMessage("x", { stdout: Buffer.alloc(9000, 0x61) });
    expect(message).toContain("… (9000 bytes)");
    expect(message.split("\n")[1]!.length).toBeLessThan(4200);
  });

  test("an abnormal exit without captured streams says so", () => {
    expect(abnormalExitMessage("x", {})).toContain("stdout <none>\n  stderr <none>");
  });
});
