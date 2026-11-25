/* A member the program added to the library Promise type, written on a
 * promise (SC6013): the program builds, and the build names what the write
 * does when it runs and what to write instead. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function memberWriteWarnings(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-promise-members-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const result = analyze(entry);
    expect(result.coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    return (result.coverage.divergences ?? [])
      .filter((d) => d.code === "SC6013")
      .map((d) => `${d.message} | ${d.hint ?? ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a write of a member an intersection adds to Promise is named, with what to write instead", () => {
  const warnings = memberWriteWarnings(
    `type Tracked<T> = Promise<T> & { status?: "pending" | "done"; value?: T };
function track(job: Promise<number>): Tracked<number> {
  const tracked: Tracked<number> = job;
  tracked.status = "pending";
  return tracked;
}
console.log(track(Promise.resolve(1)) instanceof Promise);
`,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("writing 'status' on a promise");
  expect(warnings[0]).toContain("a wrapper record");
  expect(warnings[0]).toContain("a WeakMap keyed by the promise");
});

test("a write of a member an interface adds to Promise is named too", () => {
  const warnings = memberWriteWarnings(
    `interface Cancellable extends Promise<void> { cancelled?: boolean }
function stop(job: Cancellable): void {
  job.cancelled = true;
}
console.log(typeof stop);
`,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("writing 'cancelled' on a promise");
});

test("reads of such members, and writes on the program's own objects, are not named", () => {
  expect(
    memberWriteWarnings(
      `type Tracked<T> = Promise<T> & { status?: string };
interface Job { status?: string; then(done: (value: number) => void): void }
function read(job: Tracked<number>): string {
  return job.status ?? "none";
}
function mark(job: Job): void {
  job.status = "seen";
}
const wrapper = { promise: Promise.resolve(1), status: "pending" };
wrapper.status = "done";
console.log(read(Promise.resolve(1)), typeof mark, wrapper.status);
`,
    ),
  ).toEqual([]);
});
