import { describe, expect, test } from "vitest";
import { spawnFailure } from "./spawn-failure.js";

/** execFile's error for a child a signal killed, with its captured streams. */
function signalDeath(stdout: string, stderr: string): Error {
  return Object.assign(new Error("Command failed: ./program"), {
    code: null,
    signal: "SIGSEGV",
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
}

describe("spawn failures", () => {
  test("a signal death names the signal and carries both streams", () => {
    const death = signalDeath("a\nb\n", "oops\n");
    const failure = spawnFailure(death);
    expect(failure.message).toBe(
      "Command failed: ./program (signal SIGSEGV)\nstdout:\na\nb\n\nstderr:\noops\n",
    );
    expect(failure.cause).toBe(death);
  });

  test("a stream the child left empty, or the error does not carry, is left out", () => {
    expect(spawnFailure(signalDeath("", "")).message).toBe(
      "Command failed: ./program (signal SIGSEGV)",
    );
    expect(spawnFailure(new Error("spawn ./program ENOENT")).message).toBe(
      "spawn ./program ENOENT",
    );
  });

  test("a long stream is cut to its head and names its full size", () => {
    const failure = spawnFailure(signalDeath("a".repeat(9000), ""));
    expect(failure.message).toContain("… (9000 bytes)");
    expect(failure.message.length).toBeLessThan(4200);
  });

  test("the crash report darwin left follows the streams", () => {
    const report = 'program-2026-11-06-070759.ips {"type":"EXC_BAD_ACCESS"}';
    expect(spawnFailure(signalDeath("a\n", ""), report).message).toBe(
      `Command failed: ./program (signal SIGSEGV)\nstdout:\na\n\ncrash report ${report}`,
    );
    expect(spawnFailure(signalDeath("a\n", ""), null).message).not.toContain("crash report");
  });
});
