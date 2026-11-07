// An enum object handed to JavaScript the program compiles: the schema
// helper reads its own property names and values the way schema libraries
// do, and a write it makes through the object is visible to typed code.
import { Enum, describe, tag } from "./schema.js";

enum Level {
  Low,
  High,
}
enum Env {
  development = "development",
  production = "production",
}

const levels = Enum(Level);
const envs = Enum(Env);
console.log(describe(levels), describe(envs));
console.log(levels.anyOf.length, envs.anyOf.includes("production"), envs.anyOf.includes("staging"));
tag(Env, "tagged");
console.log(Object.keys(Env).join(","), JSON.stringify(Env));
