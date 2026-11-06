import { describe, expect, test } from "vitest";
import { summarizeReport } from "./crash-report.js";

/** A `.ips` file: one metadata line, then the JSON payload. */
function ips(payload: unknown): string {
  return `${JSON.stringify({ app_name: "program", bug_type: "309" })}\n${JSON.stringify(payload)}`;
}

describe("darwin crash reports", () => {
  test("the faulting thread's frames name the library and the symbol", () => {
    const text = ips({
      exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
      termination: { namespace: "SIGNAL", code: 11 },
      faultingThread: 1,
      threads: [
        {
          frames: [{ imageIndex: 0, imageOffset: 0x100, symbol: "main", symbolLocation: 12 }],
          images: [{ name: "program" }],
        },
        {
          frames: [
            { imageIndex: 1, imageOffset: 0x24, symbol: "scr_dyn_get", symbolLocation: 40 },
            { imageIndex: 0, imageOffset: 0x1f40 },
            { imageIndex: 5 },
          ],
          images: [
            { name: "program" },
            { name: "runtime.dylib" },
            { name: "libsystem_kernel.dylib" },
            { name: "libnode.dylib" },
            { name: "libc++.1.dylib" },
            { name: "CoreFoundation" },
          ],
        },
      ],
    });
    const line = summarizeReport("program-2026-11-06-044953.ips", text);
    expect(line).toContain('"type":"EXC_BAD_ACCESS"');
    expect(line).toContain('"code":11');
    // Only the faulting thread's stack, with the images it references.
    expect(line).toContain("runtime.dylib scr_dyn_get+40 <- program +0x1f40 <- CoreFoundation +?");
    expect(line).not.toContain("main+12");
  });

  test("a report without a faulting stack keeps its exception and termination", () => {
    const line = summarizeReport(
      "program.ips",
      ips({ exception: { type: "EXC_CRASH" }, termination: { code: 6 } }),
    );
    expect(line).toBe('program.ips {"type":"EXC_CRASH"} {"code":6}');
  });

  test("an older plain-text crash report keeps its head", () => {
    const text = "Process: program [55]\nException Type: EXC_BAD_ACCESS\n";
    expect(summarizeReport("program.crash", text)).toContain("Exception Type: EXC_BAD_ACCESS");
  });

  test("a truncated payload falls back to the head instead of failing", () => {
    expect(summarizeReport("program.ips", '{"app_name":"program"}\n{"threads":[')).toContain(
      '{"threads":[',
    );
  });
});
