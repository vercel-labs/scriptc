import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type FrontendInputProbe,
  FrontendInputTracker,
  changedFrontendInput,
  frontendInputsSemanticallyMatch,
  frontendInputsStillMatch,
  invalidateTrackedFilesystem,
  invalidateTrackedPath,
  setVirtualSource,
  COMPILER_SCRATCH_PREFIX,
  clearVirtualSources,
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  trackedHostFact,
  markFrontendInputsUnstable,
  observeFrontendInputs,
  trackedReadFile,
  trackedReadSource,
  trackedWholeText,
  validFrontendInputSnapshot,
} from "./input-tracker.js";
import { observedSourceText, rewrittenSourceText, TOKEN_SPAN } from "./ts7/ast-node.js";

const scratch: string[] = [];

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("semantic validation reads non-source dependencies once and still invalidates edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const dependency = join(dir, "dependency.d.ts");
  const previous = "export const answer = 1;\n";
  const current = `// comment\n${previous}`;
  await writeFile(source, previous);
  await writeFile(dependency, "export declare const value: number;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadSource(source);
    trackedReadFile(dependency);
  });
  const snapshot = tracker.snapshot();
  await writeFile(source, current);
  const reads = vi.mocked(fs.readFileSync);
  reads.mockClear();
  const equivalent = vi.fn(() => true);
  const sources = new Map([[source, previous]]);

  const result = frontendInputsSemanticallyMatch(snapshot, sources, equivalent);
  expect(result?.currentSources).toEqual(new Map([[source, current]]));
  expect(result?.changed).toEqual([{ path: source, previous, current }]);
  expect(equivalent).toHaveBeenCalledExactlyOnceWith(source, previous, current);
  expect(reads.mock.calls.filter(([path]) => path === dependency)).toHaveLength(1);

  await writeFile(dependency, "export declare const value: string;\n");
  reads.mockClear();
  expect(frontendInputsSemanticallyMatch(snapshot, sources, equivalent)).toBeNull();
  expect(reads.mock.calls.filter(([path]) => path === dependency)).toHaveLength(1);
});

test("an equivalent edit of a file whose raw text the frontend read does not match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const previous = "export const answer = 1;\n";
  await writeFile(source, previous);
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadSource(source);
    tracker.record({ op: "text", path: source });
  });
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  await writeFile(source, `// comment\n${previous}`);
  const equivalent = vi.fn(() => true);
  expect(
    frontendInputsSemanticallyMatch(snapshot, new Map([[source, previous]]), equivalent),
  ).toBeNull();
  expect(equivalent).not.toHaveBeenCalled();
});

test("a file read by anything but the parser admits no equivalent edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const previous = "export const answer = 1;\n";
  await writeFile(source, previous);
  const tracker = new FrontendInputTracker();
  const served = join(dir, "served.ts");
  tracker.run(() => {
    trackedReadSource(source);
    // A reader that scans the content itself, after the parser's read.
    trackedReadFile(source);
    // Text a reader took from the program host instead of the file.
    trackedWholeText(served);
  });
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "text", path: source });
  expect(snapshot.probes).toContainEqual({ op: "text", path: served });
  await writeFile(source, `// comment\n${previous}`);
  const equivalent = vi.fn(() => true);
  expect(
    frontendInputsSemanticallyMatch(snapshot, new Map([[source, previous]]), equivalent),
  ).toBeNull();
  expect(equivalent).not.toHaveBeenCalled();
});

test("precise text reads are recorded per file and handed to the equivalence check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const previous = "export const answer = 1;\n";
  await writeFile(source, previous);
  const tracker = new FrontendInputTracker();
  const observer = observedSourceText()!;
  tracker.run(() => {
    const text = trackedReadSource(source)!;
    observer.range(source, text, 7, 12, TOKEN_SPAN);
    observer.range(source, text, 7, 12, TOKEN_SPAN);
    observer.position(source, text, 13);
    observer.fact(source, text, { kind: "includes", needle: "then" }, false, -1, -1, TOKEN_SPAN);
    observer.fact(source, text, { kind: "matches", source: "^export ", flags: "" }, true, 0, 24, 1);
  });
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  const reads = {
    // Offsets doubled, plus one at a token's start.
    ranges: [15, 24],
    positions: [13],
    facts: [
      { predicate: { kind: "includes", needle: "then" }, whole: false, yes: [], no: [] },
      { predicate: { kind: "matches", source: "^export ", flags: "" }, yes: [1, 48], no: [] },
    ],
  };
  expect(snapshot.probes).toContainEqual({ op: "text", path: source, reads });
  // A comment after the last token: every read has the same answer, at the
  // same offsets.
  const current = `${previous}// comment\n`;
  await writeFile(source, current);
  const equivalent = vi.fn(() => true);
  const kept = frontendInputsSemanticallyMatch(snapshot, new Map([[source, previous]]), equivalent);
  expect(equivalent).toHaveBeenCalledExactlyOnceWith(source, previous, current);
  expect(kept?.snapshot.probes).toContainEqual({ op: "text", path: source, reads });
  // A comment at the top: the caller's check accepts it, and the replay of
  // the recorded line read does not.
  await writeFile(source, `// comment\n${previous}`);
  const refused = vi.fn();
  expect(
    frontendInputsSemanticallyMatch(
      snapshot,
      new Map([[source, previous]]),
      () => true,
      {},
      refused,
    ),
  ).toBeNull();
  expect(refused).toHaveBeenCalledExactlyOnceWith(source, "edit");
  // The same edit with the line read left out moves the other reads.
  const moved = frontendInputsSemanticallyMatch(
    {
      ...snapshot,
      probes: snapshot.probes.map((probe): FrontendInputProbe =>
        probe.op === "text" && probe.reads !== undefined
          ? { op: "text", path: probe.path, reads: { ...probe.reads, positions: [] } }
          : probe,
      ),
    },
    new Map([[source, previous]]),
    () => true,
  );
  expect(moved?.snapshot.probes).toContainEqual({
    op: "text",
    path: source,
    reads: {
      ranges: [37, 46],
      positions: [],
      facts: [
        { predicate: { kind: "includes", needle: "then" }, whole: false, yes: [], no: [] },
        { predicate: { kind: "matches", source: "^export ", flags: "" }, yes: [23, 70], no: [] },
      ],
    },
  });
  expect(validFrontendInputSnapshot(moved!.snapshot)).toBe(true);
});

test("a read of text that is not the file's content counts as a read of all of it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const other = join(dir, "other.ts");
  const parsedElsewhere = join(dir, "elsewhere.ts");
  await writeFile(source, "export const answer = 1;\n");
  await writeFile(parsedElsewhere, "export const elsewhere = 3;\n");
  const tracker = new FrontendInputTracker();
  const observer = observedSourceText()!;
  tracker.run(() => {
    trackedReadSource(source);
    // A syntax tree of rewritten text: its offsets are not the file's.
    observer.range(source, "export const answer = 1 as number;\n", 7, 12, TOKEN_SPAN);
    // A synthesized source: no file holds its text.
    observer.position(other, "export const other = 2;\n", 7);
    // A file another process parsed: this tracker reads it to compare.
    observer.position(parsedElsewhere, "export const elsewhere = 3;\n", 7);
  });
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "text", path: source });
  expect(snapshot.probes).toContainEqual({ op: "text", path: other });
  expect(snapshot.probes).toContainEqual({
    op: "text",
    path: parsedElsewhere,
    reads: { ranges: [], positions: [7], facts: [] },
  });
  expect(snapshot.probes).toContainEqual(
    expect.objectContaining({ op: "file", path: parsedElsewhere }),
  );
});

test("a predicate that answered both ways for one text counts as a read of all of it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  const observer = observedSourceText()!;
  tracker.run(() => {
    const text = trackedReadSource(source)!;
    observer.fact(source, text, { kind: "includes", needle: "x" }, false, -1, -1, TOKEN_SPAN);
    observer.fact(source, text, { kind: "includes", needle: "x" }, true, -1, -1, TOKEN_SPAN);
  });
  expect(tracker.snapshot().probes).toContainEqual({ op: "text", path: source });
});

test("nested trackers join their text reads, and a whole read wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const other = join(dir, "other.ts");
  await writeFile(source, "export const answer = 1;\n");
  await writeFile(other, "export const other = 2;\n");
  const outer = new FrontendInputTracker();
  const observer = observedSourceText()!;
  outer.runSynchronous(() => {
    const text = trackedReadSource(source)!;
    const otherText = trackedReadSource(other)!;
    observer.position(source, text, 7);
    observer.position(other, otherText, 7);
    new FrontendInputTracker().runSynchronous(() => {
      const again = trackedReadSource(source)!;
      observer.position(source, again, 13);
      trackedReadFile(other);
    });
  });
  const probes = outer.snapshot().probes;
  expect(probes).toContainEqual({
    op: "text",
    path: source,
    reads: { ranges: [], positions: [7, 13], facts: [] },
  });
  expect(probes).toContainEqual({ op: "text", path: other });
});

/* A file compiled in a rewritten form (SourceTextRewrite). `A, ` is blanked
 * from the start of `A` (offset 9) to the start of `b` (offset 12). */
const ELIDED = 'import { A, b } from "./m";\nconsole.log(b);\n';
const REWRITE = { blanks: [19, 25], tail: 'import type { A } from "./m";\n' };

test("a rewrite is recorded with the reads of the form it gives, apart from the reads of the text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, ELIDED);
  const tracker = new FrontendInputTracker();
  const observer = observedSourceText()!;
  const blanked = { kind: "includes" as const, needle: "A," };
  tracker.run(() => {
    const text = trackedReadSource(source)!;
    const rewritten = rewrittenSourceText(text, REWRITE);
    expect(rewritten).toBe(
      'import {    b } from "./m";\nconsole.log(b);\nimport type { A } from "./m";\n',
    );
    observer.rewrite(source, text, REWRITE, rewritten);
    // The same rewrite again (a second load of the program) is the same form.
    observer.rewrite(source, text, { ...REWRITE, blanks: [...REWRITE.blanks] }, rewritten);
    // The start of `console`, asked of the text and of the form.
    observer.position(source, text, 28);
    observer.position(source, rewritten, 28);
    // The `A` of the appended declaration.
    observer.range(source, rewritten, 58, 59, TOKEN_SPAN);
    observer.fact(source, text, blanked, true, -1, -1, TOKEN_SPAN);
    observer.fact(source, rewritten, blanked, false, -1, -1, TOKEN_SPAN);
  });
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(snapshot.probes).toContainEqual({
    op: "text",
    path: source,
    reads: {
      ranges: [],
      positions: [28],
      facts: [{ predicate: blanked, whole: true, yes: [], no: [] }],
      rewritten: {
        ...REWRITE,
        ranges: [117, 118],
        positions: [28],
        facts: [{ predicate: blanked, whole: false, yes: [], no: [] }],
      },
    },
  });
  // A comment inside the blanked span and one after the last token: the
  // entry is kept, with the rewrite and its reads moved to the edited text.
  const current = ELIDED.replace("A, ", "A, /* a type */ ") + "// trail\n";
  await writeFile(source, current);
  const kept = frontendInputsSemanticallyMatch(snapshot, new Map([[source, ELIDED]]), () => true);
  expect(kept?.snapshot.probes).toContainEqual({
    op: "text",
    path: source,
    reads: {
      ranges: [],
      positions: [41],
      facts: [{ predicate: blanked, whole: true, yes: [], no: [] }],
      rewritten: {
        blanks: [19, 51],
        tail: REWRITE.tail,
        ranges: [161, 162],
        positions: [41],
        facts: [{ predicate: blanked, whole: false, yes: [], no: [] }],
      },
    },
  });
  expect(validFrontendInputSnapshot(kept!.snapshot)).toBe(true);
  // The form has text after the file's: a reader that moves source
  // locations to the edited text is told so.
  expect(kept?.changed).toEqual([{ path: source, previous: ELIDED, current, appended: true }]);
  // A comment the form's predicate matches: the form of the edited text
  // answers differently, though the text as written answers as before.
  await writeFile(source, ELIDED + "// A, then b\n");
  const refused = vi.fn();
  expect(
    frontendInputsSemanticallyMatch(snapshot, new Map([[source, ELIDED]]), () => true, {}, refused),
  ).toBeNull();
  expect(refused).toHaveBeenCalledExactlyOnceWith(source, "edit");
  // With source positions recorded, a line after the last token moves the
  // appended declaration.
  await writeFile(source, ELIDED + "// trail\n");
  const match = (positions: boolean) =>
    frontendInputsSemanticallyMatch(
      {
        ...snapshot,
        probes: snapshot.probes.map((probe): FrontendInputProbe =>
          probe.op === "text"
            ? {
                op: "text",
                path: source,
                reads: {
                  ranges: [],
                  positions: [],
                  facts: [],
                  rewritten: { ...REWRITE, ranges: [], positions: [], facts: [] },
                },
              }
            : probe,
        ),
      },
      new Map([[source, ELIDED]]),
      () => true,
      {},
      undefined,
      positions,
    );
  expect(match(false)).not.toBeNull();
  expect(match(true)).toBeNull();
});

test("a file compiled in two forms, or rewritten from text that is not its content, counts as read whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const twice = join(dir, "twice.ts");
  const derived = join(dir, "derived.ts");
  const later = join(dir, "later.ts");
  const misplaced = join(dir, "misplaced.ts");
  for (const path of [twice, derived, later, misplaced]) await writeFile(path, ELIDED);
  const tracker = new FrontendInputTracker();
  const observer = observedSourceText()!;
  tracker.run(() => {
    const text = trackedReadSource(twice)!;
    observer.rewrite(twice, text, REWRITE, rewrittenSourceText(text, REWRITE));
    const other = { blanks: REWRITE.blanks, tail: "export {};\n" };
    observer.rewrite(twice, text, other, rewrittenSourceText(text, other));
    // A rewrite of a rewrite: the text it starts from is not the file's.
    trackedReadSource(derived);
    const lowered = ELIDED.replace("console.log(b)", "print(b)");
    observer.rewrite(derived, lowered, REWRITE, rewrittenSourceText(lowered, REWRITE));
    // A read of a form no rewrite has reported yet.
    trackedReadSource(later);
    observer.position(later, rewrittenSourceText(ELIDED, REWRITE), 28);
    observer.rewrite(later, ELIDED, REWRITE, rewrittenSourceText(ELIDED, REWRITE));
    // Blanks that overlap, or lie outside the text.
    trackedReadSource(misplaced);
    const overlapping = { blanks: [19, 25, 21, 29], tail: "" };
    observer.rewrite(misplaced, ELIDED, overlapping, ELIDED);
  });
  const probes = tracker.snapshot().probes;
  for (const path of [twice, derived, later, misplaced])
    expect(probes).toContainEqual({ op: "text", path });
});

test("nested trackers join a rewrite and the reads of its form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const other = join(dir, "other.ts");
  await writeFile(source, ELIDED);
  await writeFile(other, ELIDED);
  const outer = new FrontendInputTracker();
  const observer = observedSourceText()!;
  const rewritten = rewrittenSourceText(ELIDED, REWRITE);
  outer.runSynchronous(() => {
    const text = trackedReadSource(source)!;
    observer.rewrite(source, text, REWRITE, rewritten);
    observer.position(source, rewritten, 28);
    const otherText = trackedReadSource(other)!;
    observer.rewrite(other, otherText, REWRITE, rewritten);
    new FrontendInputTracker().runSynchronous(() => {
      const again = trackedReadSource(source)!;
      observer.rewrite(source, again, REWRITE, rewritten);
      observer.position(source, rewritten, 44);
      // Another form of the second file.
      const second = { blanks: REWRITE.blanks, tail: "" };
      observer.rewrite(
        other,
        trackedReadSource(other)!,
        second,
        rewrittenSourceText(ELIDED, second),
      );
    });
    // The outer tracker still takes reads of the form after the join.
    observer.position(source, rewritten, 51);
  });
  const probes = outer.snapshot().probes;
  expect(probes).toContainEqual({
    op: "text",
    path: source,
    reads: {
      ranges: [],
      positions: [],
      facts: [],
      rewritten: { ...REWRITE, ranges: [], positions: [28, 44, 51], facts: [] },
    },
  });
  expect(probes).toContainEqual({ op: "text", path: other });
});

test("malformed text reads make a snapshot invalid", () => {
  const snapshot = (reads: unknown) => ({
    version: 1,
    stable: true,
    probes: [{ op: "text", path: "/a.ts", reads }],
  });
  expect(validFrontendInputSnapshot(snapshot({ ranges: [], positions: [], facts: [] }))).toBe(true);
  expect(validFrontendInputSnapshot(snapshot({ ranges: [1], positions: [], facts: [] }))).toBe(
    false,
  );
  expect(validFrontendInputSnapshot(snapshot({ ranges: [], positions: [-1], facts: [] }))).toBe(
    false,
  );
  const fact = (predicate: unknown) =>
    snapshot({ ranges: [], positions: [], facts: [{ predicate, yes: [], no: [] }] });
  expect(validFrontendInputSnapshot(fact({ kind: "matches", source: "a", flags: "i" }))).toBe(true);
  // A stateful pattern answers differently the second time it is asked.
  expect(validFrontendInputSnapshot(fact({ kind: "matches", source: "a", flags: "g" }))).toBe(
    false,
  );
  expect(validFrontendInputSnapshot(fact({ kind: "evaluates", source: "a" }))).toBe(false);
  // The reads of a rewritten form carry its rewrite and no form of their own.
  const form = (rewritten: unknown) =>
    snapshot({ ranges: [], positions: [], facts: [], rewritten });
  const reads = { ranges: [], positions: [], facts: [] };
  expect(validFrontendInputSnapshot(form({ blanks: [1, 4], tail: "", ...reads }))).toBe(true);
  expect(validFrontendInputSnapshot(form({ blanks: [1], tail: "", ...reads }))).toBe(false);
  expect(validFrontendInputSnapshot(form({ blanks: [], ...reads }))).toBe(false);
  expect(validFrontendInputSnapshot(form({ blanks: [], tail: "", ...reads, ranges: [3] }))).toBe(
    false,
  );
  expect(
    validFrontendInputSnapshot(
      form({ blanks: [], tail: "", ...reads, rewritten: { blanks: [], tail: "", ...reads } }),
    ),
  ).toBe(false);
});

test("tracked frontend reads invalidate on byte edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "entry.ts");
  await writeFile(file, "export const answer = 1;\n");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedReadFile(file)).toContain("answer"));
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await writeFile(file, "export const answer = 2;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed frontend reads invalidate when the same file becomes readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "unreadable.ts");
  await writeFile(file, "export const repaired = true;\n");
  await chmod(file, 0o000);

  const tracker = new FrontendInputTracker();
  const result = tracker.run(() => trackedReadFile(file));
  if (result !== null) {
    // Windows and privileged test users may not enforce POSIX mode bits.
    await chmod(file, 0o600);
    return;
  }
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "read-error", path: file });
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await chmod(file, 0o600);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed resolution candidates invalidate when a file appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const candidate = join(dir, "dependency.ts");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedFileExists(candidate)).toBe(false));
  const snapshot = tracker.snapshot();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await writeFile(candidate, "export const loaded = true;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("a candidate appearing during the frontend prevents cache publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const candidate = join(dir, "dependency.ts");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedFileExists(candidate)).toBe(false));
  await writeFile(candidate, "export const loaded = true;\n");
  tracker.run(() => expect(trackedReadFile(candidate)).toContain("loaded"));

  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(false);
  expect(validFrontendInputSnapshot(snapshot)).toBe(false);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("an opaque host query can decline frontend cache publication", () => {
  const tracker = new FrontendInputTracker();
  tracker.run(() => markFrontendInputsUnstable());
  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(false);
  expect(validFrontendInputSnapshot(snapshot)).toBe(false);
});

test("a host fact is an input: the entry matches only while it has its value", () => {
  vi.stubEnv("SCRIPTC_TEST_HOST_FACT", "first");
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    expect(trackedHostFact("env:SCRIPTC_TEST_HOST_FACT")).toBe("first");
    expect(trackedHostFact("env:SCRIPTC_TEST_HOST_FACT_UNSET")).toBeNull();
  });
  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(true);
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(snapshot.probes).toEqual([
    { op: "host", path: "env:SCRIPTC_TEST_HOST_FACT", value: "first" },
    { op: "host", path: "env:SCRIPTC_TEST_HOST_FACT_UNSET", value: null },
  ]);
  expect(changedFrontendInput(snapshot)).toBeNull();
  vi.stubEnv("SCRIPTC_TEST_HOST_FACT", "second");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
  expect(changedFrontendInput(snapshot)).toEqual(snapshot.probes[0]);
  vi.stubEnv("SCRIPTC_TEST_HOST_FACT", "first");
  vi.stubEnv("SCRIPTC_TEST_HOST_FACT_UNSET", "");
  expect(changedFrontendInput(snapshot)).toEqual(snapshot.probes[1]);
  vi.unstubAllEnvs();
});

test("a host fact named like an output path is still checked", () => {
  vi.stubEnv("SCRIPTC_TEST_HOST_FACT", "first");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedHostFact("env:SCRIPTC_TEST_HOST_FACT"));
  const snapshot = tracker.snapshot();
  vi.stubEnv("SCRIPTC_TEST_HOST_FACT", "second");
  expect(frontendInputsStillMatch(snapshot, { outputPaths: ["env:SCRIPTC_TEST_HOST_FACT"] })).toBe(
    false,
  );
  vi.unstubAllEnvs();
});

test("a host fact read with two values prevents cache publication", () => {
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedHostFact("env:SCRIPTC_TEST_HOST_FACT", "first");
    trackedHostFact("env:SCRIPTC_TEST_HOST_FACT", "second");
  });
  expect(tracker.snapshot().stable).toBe(false);
});

test("an unstable snapshot carries its first cause", async () => {
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    markFrontendInputsUnstable("the host answered without saying what it read");
    markFrontendInputsUnstable("a later cause");
  });
  expect(tracker.snapshot()).toEqual({
    version: 1,
    probes: [],
    stable: false,
    unstable: "the host answered without saying what it read",
  });
  expect(new FrontendInputTracker().snapshot()).toEqual({ version: 1, probes: [], stable: true });
  const outer = new FrontendInputTracker();
  outer.runSynchronous(() => {
    new FrontendInputTracker().runSynchronous(() => markFrontendInputsUnstable("inner cause"));
  });
  expect(outer.snapshot().unstable).toBe("inner cause");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "late.ts");
  const changed = new FrontendInputTracker();
  await changed.run(async () => {
    trackedFileExists(file);
    await writeFile(file, "export {};\n");
    invalidateTrackedPath(file);
    trackedReadFile(file);
  });
  expect(changed.snapshot().unstable).toBe(`${file} appeared while the frontend ran`);
});

test("directory enumeration invalidates workspace discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await mkdir(packages);

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedAccessibleEntries(packages)?.directories).toEqual([]));
  const snapshot = tracker.snapshot();
  await mkdir(join(packages, "new-member"));
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("compiler outputs do not invalidate a fresh output directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const generatedRoot = join(dir, "generated");
  const outDir = join(generatedRoot, "nested");
  const generated = join(outDir, "entry.lib.c");

  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    expect(trackedAccessibleEntries(dir)?.directories).toEqual([]);
    expect(trackedDirectoryExists(generatedRoot)).toBe(false);
    expect(trackedDirectoryExists(outDir)).toBe(false);
    expect(trackedAccessibleEntries(outDir)).toBeNull();
  });
  const snapshot = tracker.snapshot();
  const exclusions = {
    outputPaths: [generated],
    outputDirectories: [dir, generatedRoot, outDir],
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(generated, "/* generated */\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(true);

  await writeFile(join(outDir, "new-source.ts"), "export const appeared = true;\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(false);
});

test("the compiler's scratch entries beside an output do not invalidate a listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const output = join(dir, "app");
  await writeFile(join(dir, "main.ts"), "export {};\n");
  // A build in progress: its private files sit beside the output it will
  // write, named as privateSiblingPath names them.
  const mine = join(dir, `${COMPILER_SCRATCH_PREFIX}frontend-4242-k3v9x1`);
  await writeFile(mine, "{}");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedAccessibleEntries(dir));
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({
    op: "entries",
    path: dir,
    files: [basename(mine), "main.ts"].sort(),
    directories: [],
  });
  const exclusions = { outputPaths: [output], outputDirectories: [dir] };
  // The build finished: its scratch file is gone and its output is there.
  await rm(mine);
  await writeFile(output, "binary");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(true);
  // The next build's scratch file and staging directory, while it checks.
  await writeFile(join(dir, `${COMPILER_SCRATCH_PREFIX}llvm-4343-p0q8z2.ll`), "");
  await mkdir(join(dir, ".scriptc-native-a1b2c3"));
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(true);
  // Only beside an output, and only the compiler's names.
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
  expect(frontendInputsStillMatch(snapshot, { outputPaths: [join(dir, "elsewhere", "app")] })).toBe(
    false,
  );
  await writeFile(join(dir, ".hidden.ts"), "export {};\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(false);
});

test("a fresh output directory may hold the compiler's scratch entries beside its outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const outDir = join(dir, "dist");
  const output = join(outDir, "app");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedDirectoryExists(outDir));
  const snapshot = tracker.snapshot();
  const exclusions = { outputPaths: [output], outputDirectories: [outDir, dir] };
  await mkdir(outDir);
  await writeFile(output, "binary");
  await writeFile(join(outDir, `${COMPILER_SCRATCH_PREFIX}native-exe-4444-a7b6c5`), "");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(true);
  // A file of the user's there is still a change.
  await writeFile(join(outDir, "notes.ts"), "export {};\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(false);
});

test("failed directory enumeration invalidates when the operation starts succeeding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await writeFile(packages, "not a directory\n");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedAccessibleEntries(packages)).toBeNull());
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "entries-error", path: packages });
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await rm(packages);
  await mkdir(packages);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed directory enumeration invalidates when access is restored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await mkdir(packages);
  await writeFile(join(packages, "member.ts"), "export const member = true;\n");
  await chmod(packages, 0o000);

  try {
    const tracker = new FrontendInputTracker();
    const result = tracker.run(() => trackedAccessibleEntries(packages));
    if (result !== null) return; // Windows and privileged users may ignore POSIX mode bits.

    const snapshot = tracker.snapshot();
    expect(snapshot.probes).toContainEqual({ op: "entries-error", path: packages });
    expect(frontendInputsStillMatch(snapshot)).toBe(true);

    await chmod(packages, 0o700);
    expect(frontendInputsStillMatch(snapshot)).toBe(false);
  } finally {
    await chmod(packages, 0o700);
  }
});

test("synchronous tracking restores parents after throws and propagates unstable inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const first = join(dir, "first.ts");
  const second = join(dir, "second.ts");
  await writeFile(first, "export const first = 1;");
  await writeFile(second, "export const second = 2;");
  const parent = new FrontendInputTracker();
  const child = new FrontendInputTracker();
  parent.runSynchronous(() => {
    expect(() =>
      child.runSynchronous(() => {
        trackedReadFile(first);
        markFrontendInputsUnstable();
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    trackedReadFile(second);
  });
  expect(
    parent
      .snapshot()
      .probes.filter((probe) => probe.op === "file")
      .map((probe) => probe.path),
  ).toEqual([first, second]);
  expect(parent.snapshot().stable).toBe(false);
  const before = parent.snapshot();
  trackedFileExists(join(dir, "outside.ts"));
  expect(parent.snapshot()).toEqual(before);
});

test("a settled file is checked by its identity, and any write invalidates it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const written = fs.statSync(source);
  // The file was last changed long enough before the read.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5000);
  const tracker = new FrontendInputTracker();
  try {
    tracker.run(() => trackedReadFile(source));
  } finally {
    vi.useRealTimers();
  }
  const snapshot = tracker.snapshot();
  const probe = snapshot.probes.find((entry) => entry.op === "file");
  expect(probe?.op === "file" && probe.identity !== undefined).toBe(true);
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  const reads = vi.mocked(fs.readFileSync);
  reads.mockClear();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === source)).toHaveLength(0);
  // A same-size rewrite that restores the modification time still changes
  // the change time.
  await writeFile(source, "export const answer = 2;\n");
  fs.utimesSync(source, written.atime, written.mtime);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("a settled file an earlier run read keeps that run's digest until it is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const settledRead = (tracker: FrontendInputTracker, later: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + later);
    try {
      tracker.runSynchronous(() => trackedReadFile(source));
    } finally {
      vi.useRealTimers();
    }
    const probe = tracker.snapshot().probes.find((entry) => entry.op === "file");
    return probe?.op === "file" ? probe : undefined;
  };
  const first = settledRead(new FrontendInputTracker(), 5000)!;
  expect(first.identity).toBeDefined();
  // A digest only the previous snapshot holds shows it was not computed again.
  const marker = "f".repeat(64);
  const previous = { version: 1 as const, stable: true, probes: [{ ...first, digest: marker }] };
  expect(settledRead(new FrontendInputTracker(previous), 5000)?.digest).toBe(marker);
  await writeFile(source, "export const answer = 2;\n");
  const rewritten = settledRead(new FrontendInputTracker(previous), 10000);
  expect(rewritten?.identity).not.toBe(first.identity);
  expect(rewritten?.digest).toBe(
    createHash("sha256").update("export const answer = 2;\n").digest("hex"),
  );
});

test("a file changed shortly before the read is hashed on every check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(source));
  const snapshot = tracker.snapshot();
  const probe = snapshot.probes.find((entry) => entry.op === "file");
  expect(probe?.op === "file" && probe.identity).toBeUndefined();
  const reads = vi.mocked(fs.readFileSync);
  reads.mockClear();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === source)).toHaveLength(1);
});

test("a read before and a read after a file settles record one probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  // The first read comes right after the write, the second once the file
  // has been unchanged long enough for its identity to stand for it.
  tracker.run(() => trackedReadFile(source));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5000);
  try {
    tracker.run(() => trackedReadFile(source));
  } finally {
    vi.useRealTimers();
  }
  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(true);
  const probe = snapshot.probes.find((entry) => entry.op === "file");
  expect(probe?.op === "file" && probe.identity !== undefined).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  // The identity still invalidates the snapshot on any write.
  await writeFile(source, "export const answer = 2;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("two reads of a file that saw different content prevent cache publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(source));
  await writeFile(source, "export const answer = 2;\n");
  // A write the compile did not declare is not observed: the second read is
  // the answer this compile already used. Declaring it re-reads the file.
  tracker.run(() => {
    invalidateTrackedFilesystem();
    trackedReadFile(source);
  });
  expect(tracker.snapshot().stable).toBe(false);
});

test("a change between two reads of an unsettled file prevents cache publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  // The clock stands a minute before the file's write, so no read below finds
  // the file settled, however long the machine takes between the steps.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 60_000);
  try {
    expect(tracker.run(() => trackedReadFile(source))).toBe("export const answer = 1;\n");
    fs.writeFileSync(source, "export const answer = 2;\n");
    // The first read recorded no identity, so this one asks the disk without
    // the write being declared.
    expect(tracker.run(() => trackedReadFile(source))).toBe("export const answer = 2;\n");
  } finally {
    vi.useRealTimers();
  }
  expect(tracker.snapshot().stable).toBe(false);
  expect(tracker.snapshot().probes.filter((probe) => probe.op === "file")).toHaveLength(1);
});

test("a repeated probe is served from this compile's first answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  // Reads settle: the first one recorded an identity that stands for its
  // content, which is what lets the answers below be reused.
  let later = 5000;
  const read = (): string | null => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + later);
    later += 5000;
    try {
      return tracker.run(() => trackedReadFile(source));
    } finally {
      vi.useRealTimers();
    }
  };
  expect(read()).toBe("export const answer = 1;\n");

  await writeFile(source, "export const answer = 2;\n");
  expect(read()).toBe("export const answer = 1;\n");

  tracker.run(() => invalidateTrackedPath(source));
  expect(read()).toBe("export const answer = 2;\n");

  // One probe per operation: the re-read replaced the answer this compile
  // had served, and the difference keeps the result out of the cache.
  expect(tracker.snapshot().probes.filter((probe) => probe.op === "file")).toHaveLength(1);
  expect(tracker.snapshot().stable).toBe(false);
});

test("a cached directory listing still carries the shadow's sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "node_modules");
  await mkdir(packages);
  await writeFile(join(packages, "real.js"), "module.exports = 1;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => setVirtualSource(join(packages, "shadow.js"), "module.exports = 2;\n"));

  // The shadow's source is not part of the disk listing, which is the
  // answer this compile keeps, so it is added to every answer.
  expect(tracker.run(() => trackedAccessibleEntries(packages))?.files).toEqual([
    "real.js",
    "shadow.js",
  ]);
  expect(tracker.run(() => trackedAccessibleEntries(packages))?.files).toEqual([
    "real.js",
    "shadow.js",
  ]);
  tracker.run(() => clearVirtualSources());
});

test("virtual sources drop the answers they replace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const onDisk = 1;\n");
  const tracker = new FrontendInputTracker();
  const read = (): string | null => tracker.run(() => trackedReadFile(source));
  let later = 5000;
  const settledRead = (): string | null => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + later);
    later += 5000;
    try {
      return read();
    } finally {
      vi.useRealTimers();
    }
  };
  expect(settledRead()).toBe("export const onDisk = 1;\n");

  // The shadow answers while it is registered; registering it dropped the
  // settled real answer it replaced, so clearing it asks the disk again
  // rather than answering from what this compile read before the shadow.
  await writeFile(source, "export const onDisk = 3;\n");
  tracker.run(() => setVirtualSource(source, "export const fromShadow = 2;\n"));
  expect(read()).toBe("export const fromShadow = 2;\n");
  tracker.run(() => clearVirtualSources());
  expect(settledRead()).toBe("export const onDisk = 3;\n");
});

test("a nested observation reports its own inputs and passes them to the running tracker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const before = join(dir, "before.ts");
  const inside = join(dir, "inside.ts");
  await writeFile(before, "export const before = 1;\n");
  await writeFile(inside, "export const inside = 2;\n");
  const paths = (tracker: FrontendInputTracker): string[] =>
    tracker.snapshot().probes.map((probe) => probe.path);

  // Under the asynchronous tracker of a Node-hosted compile.
  const asynchronous = new FrontendInputTracker();
  const nested = asynchronous.run(() => {
    trackedReadSource(before);
    return observeFrontendInputs(() => {
      markFrontendInputsUnstable();
      return trackedReadSource(inside);
    });
  });
  expect(nested.result).toBe("export const inside = 2;\n");
  expect(nested.inputs.probes.map((probe) => probe.path)).toEqual([inside]);
  expect(nested.inputs.stable).toBe(false);
  expect(paths(asynchronous)).toEqual([before, inside]);
  expect(asynchronous.snapshot().stable).toBe(false);

  // Under the synchronous tracker of the native compiler.
  const synchronous = new FrontendInputTracker();
  const observed = synchronous.runSynchronous(() => {
    trackedReadSource(before);
    return observeFrontendInputs(() => trackedReadSource(inside));
  });
  expect(observed.inputs.probes.map((probe) => probe.path)).toEqual([inside]);
  expect(observed.inputs.stable).toBe(true);
  expect(paths(synchronous)).toEqual([before, inside]);

  // With no tracker running.
  const alone = observeFrontendInputs(() => trackedReadSource(inside));
  expect(alone.inputs.probes.map((probe) => probe.path)).toEqual([inside]);
});

test("a replay names the first input that changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const kept = join(dir, "a.ts");
  const edited = join(dir, "b.ts");
  await writeFile(kept, "export const a = 1;\n");
  await writeFile(edited, "export const b = 1;\n");
  const { inputs } = observeFrontendInputs(() => {
    trackedReadFile(kept);
    trackedReadFile(edited);
    trackedFileExists(join(dir, "c.ts"));
  });
  expect(changedFrontendInput(inputs)).toBeNull();
  await writeFile(join(dir, "c.ts"), "export const c = 1;\n");
  expect(changedFrontendInput(inputs)).toMatchObject({ op: "kind", path: join(dir, "c.ts") });
  // A path the build writes is not an input.
  expect(changedFrontendInput(inputs, { outputPaths: [join(dir, "c.ts")] })).toBeNull();
  await writeFile(edited, "export const b = 2;\n");
  expect(changedFrontendInput(inputs)).toMatchObject({ op: "file", path: edited });
  // An unstable snapshot is still replayed; whether it is trusted is the caller's question.
  expect(changedFrontendInput({ ...inputs, stable: false })).toMatchObject({ path: edited });
  expect(frontendInputsStillMatch({ ...inputs, stable: false })).toBe(false);
});
