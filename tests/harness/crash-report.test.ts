import { describe, expect, test } from "vitest";
import { reportDirListing, reportNameMatches, summarizeReport } from "./crash-report.js";

/** A `.ips` file: one metadata line, then the JSON payload. */
function ips(payload: unknown): string {
  return `${JSON.stringify({ app_name: "program", bug_type: "309" })}\n${JSON.stringify(payload)}`;
}

describe("darwin crash reports", () => {
  test("the faulting thread's frames name the library from the payload's image table", () => {
    const text = ips({
      exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
      termination: { namespace: "SIGNAL", code: 11 },
      vmRegionInfo: "0x10549c000 is not in any region.  Bytes before following region: 66060288",
      faultingThread: 1,
      threads: [
        { frames: [{ imageIndex: 0, imageOffset: 0x100, symbol: "main", symbolLocation: 12 }] },
        {
          frames: [
            { imageIndex: 1, imageOffset: 0x24, symbol: "scr_dyn_get", symbolLocation: 40 },
            { imageIndex: 0, imageOffset: 0x1f40 },
            { imageIndex: 5 },
          ],
        },
      ],
      usedImages: [
        { name: "program", path: "/Users/runner/program" },
        { name: "runtime.dylib", path: "/Users/runner/runtime.dylib" },
        { name: "libsystem_kernel.dylib", path: "/usr/lib/system/libsystem_kernel.dylib" },
        { name: "libnode.dylib", path: "/Users/runner/libnode.dylib" },
        { name: "libc++.1.dylib", path: "/usr/lib/libc++.1.dylib" },
        {
          name: "CoreFoundation",
          path: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
        },
      ],
    });
    const line = summarizeReport("program-2026-11-06-044953.ips", text);
    expect(line).toContain('"type":"EXC_BAD_ACCESS"');
    expect(line).toContain('"code":11');
    // The fault address's place among the process's mappings.
    expect(line).toContain("is not in any region.  Bytes before following region: 66060288");
    // Only the faulting thread's stack, with the images it references.
    expect(line).toContain("runtime.dylib scr_dyn_get+40 <- program +0x1f40 <- CoreFoundation +?");
    expect(line).not.toContain("main+12");
  });

  test("a frame whose image the table does not name keeps its index and offset", () => {
    const line = summarizeReport(
      "program.ips",
      ips({
        faultingThread: 0,
        threads: [{ frames: [{ imageIndex: 1, imageOffset: 0x24 }, { imageOffset: 0x8 }] }],
      }),
    );
    expect(line).toBe("program.ips image 1 +0x24 <- ? +0x8");
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

  test("a report whose name the kernel cut short still belongs to its binary", () => {
    // ReportCrash names the file after the process name the kernel reports,
    // which is the binary's basename cut to a task name's length.
    expect(
      reportNameMatches("program-llvm-rel-2026-11-06-044953.ips", "/tmp/x/program-llvm-release"),
    ).toBe(true);
  });

  test("a report for another binary in the same directory does not match", () => {
    // The shorter binary must not claim a report that names a longer one.
    expect(reportNameMatches("program-llvm-rel-2026-11-06-044953.ips", "/tmp/x/program")).toBe(
      false,
    );
  });

  test("a crash with no report of its own lists what the directories hold", () => {
    const listing = reportDirListing((dir) => {
      if (dir.startsWith("/Library")) throw new Error("denied");
      return ["notes.txt", "program-2026-11-06-044953.ips", "other-2026-11-06-055000.ips"];
    });
    expect(listing).toContain("newest program-2026-11-06-044953.ips");
    expect(listing).toContain("/Library/Logs/DiagnosticReports: unreadable");
    // Only reports count: another file in the directory is not one.
    expect(listing).not.toContain("notes.txt");
  });
});
