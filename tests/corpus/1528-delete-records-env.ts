// Statement-position delete: pure Record<string, T> keys (the env-copy
// sanitization idiom — an overflow Map delete, insertion order kept) and
// process.env keys (unsetenv — later reads, `in` tests, and spawned
// children observe the removal; a read tsc narrowed past the union still
// answers FRESH, the volatility rule).
const env: Record<string, string> = { PATH: "/bin", Path: "/dup", HOME: "/root", path: "/tri" };
for (const key of Object.keys(env)) {
  if (key !== "PATH" && key.toUpperCase() === "PATH") {
    delete env[key];
  }
}
console.log(JSON.stringify(env), Object.keys(env).join(","));
delete env.HOME;
console.log(JSON.stringify(env));
delete env["MISSING"]; // absent key: a no-op, like JS
console.log(Object.keys(env).length);
const counts: Record<string, number> = { a: 1, b: 2, c: 3 };
delete counts["b"];
console.log(JSON.stringify(counts), Object.keys(counts).join(""));

process.env.SCRIPTC_DEL_A = "alpha";
console.log(process.env.SCRIPTC_DEL_A, "SCRIPTC_DEL_A" in process.env);
delete process.env.SCRIPTC_DEL_A;
console.log(process.env.SCRIPTC_DEL_A === undefined, "SCRIPTC_DEL_A" in process.env);
// The write narrowed the read type; the delete makes the FRESH read the
// only honest answer (no stale fold).
process.env.SCRIPTC_DEL_B = "beta";
delete process.env.SCRIPTC_DEL_B;
console.log(process.env.SCRIPTC_DEL_B === undefined, process.env.SCRIPTC_DEL_B !== undefined);
const KEY = "SCRIPTC_DEL_C";
process.env[KEY] = "gamma";
console.log(process.env[KEY]);
delete process.env[KEY];
console.log(process.env[KEY] === undefined);
// The VALUE form answers Node's boolean and unsets the real variable too:
// the environment is one live object, not the snapshot a value lowering of
// the receiver would copy.
process.env.SCRIPTC_DEL_D = "delta";
console.log(delete process.env.SCRIPTC_DEL_D, process.env.SCRIPTC_DEL_D === undefined);
process.env.SCRIPTC_DEL_E = "epsilon";
const valueKey = "SCRIPTC_DEL_E";
console.log(delete process.env[valueKey], process.env.SCRIPTC_DEL_E === undefined);
process.env.SCRIPTC_DEL_F = "phi";
const computedValueKey: string = ["SCRIPTC", "DEL", "F"].join("_");
console.log(delete process.env[computedValueKey], process.env.SCRIPTC_DEL_F === undefined);
console.log(delete process.env.SCRIPTC_NEVER_SET);
// Parentheses and `!` are erased at runtime: they name the same live
// object, so reads, writes and deletes through them reach the real
// environment (a receiver taken for the snapshot would leave the variable
// set).
process.env.SCRIPTC_DEL_PAREN = "paren";
console.log(delete (process.env).SCRIPTC_DEL_PAREN, process.env.SCRIPTC_DEL_PAREN === undefined);
process.env.SCRIPTC_DEL_PAREN_STMT = "paren-stmt";
delete (process.env).SCRIPTC_DEL_PAREN_STMT;
console.log(process.env.SCRIPTC_DEL_PAREN_STMT === undefined);
process.env.SCRIPTC_DEL_NONNULL = "nonnull";
console.log(delete process.env!.SCRIPTC_DEL_NONNULL, process.env.SCRIPTC_DEL_NONNULL === undefined);
process.env.SCRIPTC_DEL_NONNULL_STMT = "nonnull-stmt";
delete process.env!.SCRIPTC_DEL_NONNULL_STMT;
console.log(process.env.SCRIPTC_DEL_NONNULL_STMT === undefined);
(process.env).SCRIPTC_DEL_WRITE = "written";
console.log(process.env.SCRIPTC_DEL_WRITE, "SCRIPTC_DEL_WRITE" in process.env);
(process.env)["SCRIPTC_DEL_INDEX"] = "indexed";
console.log(process.env["SCRIPTC_DEL_INDEX"]);
delete (process.env)["SCRIPTC_DEL_INDEX"];
console.log(process.env.SCRIPTC_DEL_INDEX === undefined);
