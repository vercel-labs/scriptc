/* The npm semver range subset type patches key on (`commander@^15.0.0`):
 * exact versions, x-ranges, `^`, `~`, comparators, hyphen ranges and `||`.
 * A prerelease version satisfies a comparator set only when one of the
 * set's comparators names a prerelease of the same major.minor.patch, as
 * npm does. */

interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: readonly (string | number)[];
}

interface Comparator {
  op: "<" | "<=" | ">" | ">=" | "=";
  version: Version;
}

/** A partial version: missing or wildcard parts are null. */
interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
  pre: readonly (string | number)[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function preParts(text: string | undefined): (string | number)[] {
  if (text === undefined || text === "") return [];
  return text.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/** A full version, or null. */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: preParts(m[4]) };
}

function parsePartial(text: string): Partial | null {
  const m =
    /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      text,
    );
  if (m === null) return null;
  const part = (s: string | undefined): number | null =>
    s === undefined || s === "x" || s === "X" || s === "*" ? null : Number(s);
  const major = part(m[1]);
  const minor = major === null ? null : part(m[2]);
  const patch = minor === null ? null : part(m[3]);
  return { major, minor, patch, pre: patch === null ? [] : preParts(m[4]) };
}

function v(
  major: number,
  minor: number,
  patch: number,
  pre: readonly (string | number)[] = [],
): Version {
  return { major, minor, patch, pre };
}

/** `-0` marks the lowest prerelease, so `<2.0.0-0` excludes 2.0.0's
 * prereleases as npm's desugaring does. */
const LOWEST: readonly (string | number)[] = [0];

function comparePre(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

/** The comparators a partial with an operator stands for. */
function desugar(op: string, p: Partial): Comparator[] | null {
  const { major, minor, patch } = p;
  if (op === "^") {
    if (major === null) return [];
    const lo = v(major, minor ?? 0, patch ?? 0, p.pre);
    let hi: Version;
    if (major > 0 || minor === null) hi = v(major + 1, 0, 0, LOWEST);
    else if (minor > 0 || patch === null) hi = v(0, minor + 1, 0, LOWEST);
    else hi = v(0, 0, patch + 1, LOWEST);
    return [
      { op: ">=", version: lo },
      { op: "<", version: hi },
    ];
  }
  if (op === "~") {
    if (major === null) return [];
    const lo = v(major, minor ?? 0, patch ?? 0, p.pre);
    const hi = minor === null ? v(major + 1, 0, 0, LOWEST) : v(major, minor + 1, 0, LOWEST);
    return [
      { op: ">=", version: lo },
      { op: "<", version: hi },
    ];
  }
  if (op === "" || op === "=") {
    if (major === null) return [];
    if (minor === null)
      return [
        { op: ">=", version: v(major, 0, 0) },
        { op: "<", version: v(major + 1, 0, 0, LOWEST) },
      ];
    if (patch === null)
      return [
        { op: ">=", version: v(major, minor, 0) },
        { op: "<", version: v(major, minor + 1, 0, LOWEST) },
      ];
    return [{ op: "=", version: v(major, minor, patch, p.pre) }];
  }
  if (major === null)
    return op === "<" || op === ">" ? [{ op: "<", version: v(0, 0, 0, LOWEST) }] : [];
  if (op === ">") {
    if (minor === null) return [{ op: ">=", version: v(major + 1, 0, 0) }];
    if (patch === null) return [{ op: ">=", version: v(major, minor + 1, 0) }];
    return [{ op: ">", version: v(major, minor, patch, p.pre) }];
  }
  if (op === ">=") return [{ op: ">=", version: v(major, minor ?? 0, patch ?? 0, p.pre) }];
  if (op === "<") {
    if (minor === null) return [{ op: "<", version: v(major, 0, 0, LOWEST) }];
    if (patch === null) return [{ op: "<", version: v(major, minor, 0, LOWEST) }];
    return [{ op: "<", version: v(major, minor, patch, p.pre) }];
  }
  if (op === "<=") {
    if (minor === null) return [{ op: "<", version: v(major + 1, 0, 0, LOWEST) }];
    if (patch === null) return [{ op: "<", version: v(major, minor + 1, 0, LOWEST) }];
    return [{ op: "<=", version: v(major, minor, patch, p.pre) }];
  }
  return null;
}

/** One `||` alternative: a list of comparators, or null when malformed. */
function parseSet(text: string): Comparator[] | null {
  const t = text.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(t);
  if (hyphen !== null) {
    const lo = parsePartial(hyphen[1]!);
    const hi = parsePartial(hyphen[2]!);
    if (lo === null || hi === null) return null;
    return [...(desugar(">=", lo) ?? []), ...(desugar("<=", hi) ?? [])];
  }
  if (t === "") return [];
  const out: Comparator[] = [];
  // `>= 1.2.3` may carry a space between the operator and the version.
  const tokens = t.replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1").split(/\s+/);
  for (const token of tokens) {
    const m = /^(<=|>=|<|>|=|\^|~>?|)(.*)$/.exec(token);
    if (m === null) return null;
    const op = m[1] === "~>" ? "~" : m[1]!;
    const p = parsePartial(m[2]!);
    if (p === null) return null;
    const cs = desugar(op, p);
    if (cs === null) return null;
    out.push(...cs);
  }
  return out;
}

/** The parsed range, or null when it is not a semver range. */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.split("||")) {
    const set = parseSet(alt);
    if (set === null) return null;
    sets.push(set);
  }
  return sets;
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== null;
}

function test(c: Comparator, version: Version): boolean {
  const cmp = compareVersions(version, c.version);
  switch (c.op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    default:
      return cmp === 0;
  }
}

/** True when `version` satisfies `range` (false for malformed input). */
export function satisfies(version: string, range: string): boolean {
  const ver = parseVersion(version);
  const sets = parseRange(range);
  if (ver === null || sets === null) return false;
  return sets.some((set) => {
    if (!set.every((c) => test(c, ver))) return false;
    if (ver.pre.length === 0) return true;
    // A prerelease only matches a set that names a prerelease of the same
    // version tuple (the LOWEST markers of upper bounds do not count).
    return set.some(
      (c) =>
        c.version.pre.length > 0 &&
        c.version.pre !== LOWEST &&
        c.version.major === ver.major &&
        c.version.minor === ver.minor &&
        c.version.patch === ver.patch,
    );
  });
}
