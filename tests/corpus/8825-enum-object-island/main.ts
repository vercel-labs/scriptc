// @requires-libnode
// An enum object crossing into Node: as an argument of a call into a
// CommonJS file (@scriptc/node), and as an argument of a schema library
// that runs in a Node island. Both see the object tsc's emit builds.
import { callSync } from "@scriptc/node";
import { Enum, describe, check, type EnumSchema } from "enumkit";

enum Level {
  Low,
  High,
  Top = 10,
}
export enum NodeEnv {
  development = "development",
  test = "test",
  production = "production",
}

console.log(callSync<string>("./inspect.cjs", "summary", Level));
console.log(callSync<string>("./inspect.cjs", "summary", NodeEnv));
console.log(callSync<string[]>("./inspect.cjs", "names", Level).join(","));

const levelSchema: EnumSchema = Enum(Level);
const envSchema = Enum(NodeEnv);
console.log(describe(levelSchema), describe(envSchema));
console.log(check(envSchema, "test"), check(envSchema, "staging"), check(levelSchema, 10), check(levelSchema, "Low"));
const env: string = process.argv[2] ?? NodeEnv.production;
console.log(check(envSchema, env), Object.values(NodeEnv).includes(env as NodeEnv));
