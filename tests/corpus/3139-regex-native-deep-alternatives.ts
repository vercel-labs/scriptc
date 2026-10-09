// Runtime patterns with very long runs of alternatives. libregexp compiles
// `a|b|c` as a chain of splits, each targeting the next alternative's split,
// so the native matcher's first-byte analysis walks a chain as long as the
// pattern while the regex is constructed. That walk must not grow the C stack
// with the pattern: these patterns compile and match on one-byte (ASCII)
// subjects exactly as they do in Node.

const N = 30000;

function show(m: RegExpExecArray | null): string {
  if (m === null) return "null";
  const parts: string[] = [];
  for (let i = 0; i < m.length; i++) parts.push(m[i] === undefined ? "<u>" : JSON.stringify(m[i]));
  return `@${m.index} [${parts.join(", ")}]`;
}

function run(label: string, source: string, subjects: string[]): void {
  const re = new RegExp(source);
  for (const subject of subjects) console.log(label, JSON.stringify(subject), show(re.exec(subject)), re.test(subject));
}

// One group with a long run of empty alternatives.
run("empty", "(?:" + "|".repeat(N) + "x)", ["abc", ""]);
run("empty-then", "(?:" + "|".repeat(N) + "x)y", ["zzy", "xy", "zz"]);
run("empty-capture", "(" + "|".repeat(N) + "x)(y)", ["zy", "y"]);

// Alternatives that consume, like a large keyword alternation.
run("literals", "(?:" + "a|".repeat(N) + "b)", ["zzb", "zza", "zz"]);
run("words", "\\b(?:" + "if|".repeat(N) + "else)\\b", ["x else y", "iffy if"]);

// Nested groups inside a flat run: each alternative is shallow, the run is long.
run("empty-groups", "(?:" + "(?:)|".repeat(N) + "x)y", ["zy"]);
run("optional-groups", "(?:" + "(?:a|)|".repeat(N / 2) + "b)c", ["zac", "zc"]);
run("nested-runs", "(?:(?:" + "|".repeat(N / 2) + ")|" + "|".repeat(N / 2) + "x)y", ["zy", "xy"]);

// Global matching and replacement re-enter the same program.
const global = new RegExp("(?:" + "a|".repeat(N) + "[0-9])", "g");
console.log("global", JSON.stringify("a1b22c333".match(global)));
console.log("replace", "a1b22c333".replace(global, "#"));
