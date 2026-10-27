// An index signature whose value admits undefined already describes an
// optional member of the same type (`interface Env extends Dict<string>
// { TZ?: string }`, @types/node's ProcessEnv): such a record is one key
// set in insertion order, so spread, delete, `in` and every enumeration
// treat the declared member like any other key.
interface Env {
  TZ?: string;
  [key: string]: string | undefined;
}

const base: Env = { A: "1", TZ: "UTC", B: "2" };
const env = { ...base };
env.C = "3";
for (const key of ["A", "TZ", "MISSING"]) {
  delete env[key];
}
console.log(Object.entries(env), Object.keys(base));
const probe = (key: string): boolean => key in env;
console.log(probe("TZ"), probe("B"), env.TZ, env.B);
env.TZ = "Europe/Berlin";
console.log(JSON.stringify(env), env);

const extended: Env = { ...base, D: "4" };
delete extended.TZ;
extended.TZ = "Asia/Tokyo";
console.log(extended, Object.keys(extended).join(","));

// A declared member written after another key comes after it.
interface Scores {
  best?: number;
  [name: string]: number | undefined;
}
const scores: Scores = {};
scores["x"] = 1;
scores.best = 2;
console.log(Object.keys(scores), JSON.stringify(scores));

// The process environment has the same shape; a child environment built
// from it keeps the parent's keys in order.
process.env.SCX_FIRST = "first";
process.env.SCX_DROP = "drop";
process.env.SCX_LAST = "last";
const DROP = ["SCX_DROP", "SCX_NOT_SET"];
function childEnv(): string[] {
  const runEnv = { ...process.env };
  runEnv.SCX_ADDED = "added";
  for (const key of DROP) {
    delete runEnv[key];
  }
  runEnv.SCX_FIRST = runEnv.SCX_FIRST ? `${runEnv.SCX_FIRST}!` : "none";
  return Object.entries(runEnv)
    .filter(([key]) => key.startsWith("SCX_"))
    .map(([key, value]) => `${key}=${value || ""}`);
}
console.log(childEnv());

// A record of declared optional members over a slot without undefined is
// the same key set: merging it over the process environment keeps both.
type Dictionary<T> = { [key: string]: T };
type BuildEnv = { CI?: string; DEBUG?: string } & Dictionary<string>;
function merged(buildEnv: BuildEnv): string[] {
  const env = { ...process.env, ...buildEnv };
  return [
    String(env.CI === "1" || env.SCX_FIRST === "first"),
    `${env.DEBUG ?? "-"}`,
    Object.keys(env)
      .filter((key) => key.startsWith("SCX_") || key === "CI" || key === "DEBUG")
      .join(","),
  ];
}
const buildEnv: BuildEnv = { SCX_BUILD: "b", CI: "1" };
buildEnv.DEBUG = "yes";
console.log(merged(buildEnv), Object.keys(buildEnv), buildEnv.CI, buildEnv["SCX_BUILD"]);
