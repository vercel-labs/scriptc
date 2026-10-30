/* Selection helpers for the Test262 runner: the path list, the chapter cap and
 * the journal replay. Kept out of run.ts so the rules can be unit tested
 * without compiling anything (tests/harness/test262-runner.test.ts).
 *
 * Every selector narrows; the runner applies path selection, then variants,
 * then the journal replay. Nothing here reads a test source. */

/** Every outcome the runner records. `--status` accepts these names only: a
 * typo would otherwise silently rerun nothing or rerun everything. */
export const outcomeStatuses = new Set([
  "pass", "excluded", "fail", "compile-refusal", "runtime-refusal", "harness-refusal",
  "compiler-error", "build-error", "crash", "timeout", "runner-error",
]);

/** Statuses a plain "rerun what failed" selects: everything the runner
 * measured as an unexpected outcome. Passes and profile exclusions are not
 * failures. */
export const failingStatuses = [...outcomeStatuses].filter((status) => status !== "pass" && status !== "excluded");

/** The chapter a test belongs to: `test/<area>/<group>`, matching the survey's
 * per-chapter table (test/built-ins/DataView, test/language/expressions,
 * test/staging/sm, test/annexB/built-ins). */
export function chapterOf(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.length >= 3 ? parts.slice(0, 3).join("/") : path;
}

/** Parse a path list file: one test path per line, blank lines and `#`
 * comments ignored. Lines may be absolute paths, `./test/...`, or paths
 * relative to the snapshot root (`built-ins/DataView/foo.js`). */
export function readPathList(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let path = line.replaceAll("\\", "/");
    const at = path.indexOf("test/");
    if (at > 0) path = path.slice(at);
    while (path.startsWith("./")) path = path.slice(2);
    lines.push(path.replace(/^\/+/, ""));
  }
  return lines;
}

/** Resolve a listed path against the inventory. An exact match wins; otherwise
 * a unique suffix match (`built-ins/DataView/x.js` for
 * `test/built-ins/DataView/x.js`) is accepted. Unknown or ambiguous entries
 * throw: a mistyped path must not silently run a smaller set. */
export function resolveListedPaths(list, paths) {
  const known = new Set(paths);
  const bySuffix = new Map();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      bySuffix.set(suffix, bySuffix.has(suffix) ? null : path);
    }
  }
  const selected = new Set();
  const unknown = [];
  const ambiguous = [];
  for (const entry of new Set(list)) {
    if (known.has(entry)) selected.add(entry);
    else if (bySuffix.get(entry)) selected.add(bySuffix.get(entry));
    else if (bySuffix.has(entry)) ambiguous.push(entry);
    else unknown.push(entry);
  }
  if (unknown.length || ambiguous.length) {
    const report = (label, entries) => entries.length
      ? `${label} (${entries.length}): ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", ..." : ""}`
      : undefined;
    throw new Error(["--files does not match the Test262 inventory", report("unknown", unknown), report("ambiguous", ambiguous)]
      .filter(Boolean).join("; "));
  }
  return selected;
}

/** Cap each chapter at `limit` files, spreading the sample over the chapter so
 * it covers the whole directory instead of only its alphabetically first
 * entries. Chapters keep their sorted order and so do the files within. */
export function limitPerChapter(paths, limit) {
  const chapters = new Map();
  for (const path of paths) {
    const chapter = chapterOf(path);
    const list = chapters.get(chapter);
    if (list) list.push(path);
    else chapters.set(chapter, [path]);
  }
  const selected = [];
  for (const chapter of [...chapters.keys()].sort()) {
    const list = chapters.get(chapter);
    if (list.length <= limit) { selected.push(...list); continue; }
    const taken = limit === 1
      ? [list[0]]
      : Array.from({ length: limit }, (_, index) => list[Math.floor((index * (list.length - 1)) / (limit - 1))]);
    selected.push(...new Set(taken));
  }
  return selected;
}

/** Parse `--status` values: each flag may hold a comma-separated list.
 * Defaults to every failing status. */
export function parseStatuses(values) {
  if (values === undefined || values.length === 0) return new Set(failingStatuses);
  const statuses = new Set();
  for (const value of values) {
    for (const name of value.split(",")) {
      const status = name.trim();
      if (status === "") continue;
      if (!outcomeStatuses.has(status)) {
        throw new Error(`--status must name runner outcomes; got "${status}" (expected one of: ${[...outcomeStatuses].join(", ")})`);
      }
      statuses.add(status);
    }
  }
  if (statuses.size === 0) throw new Error("--status selected no outcomes");
  return statuses;
}

/** The variant id a journal record carries: `<path>#<variant>`. */
export function idPath(id) {
  const at = id.lastIndexOf("#");
  return at <= 0 ? undefined : id.slice(0, at);
}

/** The ids a journal selects, deduplicated in first-seen order. Journals are
 * append-only and a shard can be topped up by a second run, so duplicates are
 * normal. Malformed lines throw: rerunning a silently truncated set would
 * report a false green. */
export function readJournalIds(text, statuses) {
  const ids = new Set();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`journal line ${index + 1} is not JSON: ${line.slice(0, 120)}`);
    }
    if (typeof record?.id !== "string" || typeof record?.status !== "string") {
      throw new Error(`journal line ${index + 1} has no string id and status`);
    }
    if (statuses.has(record.status) && idPath(record.id)) ids.add(record.id);
  }
  return ids;
}
