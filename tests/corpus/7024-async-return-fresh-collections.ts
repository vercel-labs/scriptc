// Async functions can return an empty array literal (where the result is
// inferred) or a new Map or Set: the value takes the result's element
// types, as a synchronous return does.
import { existsSync, readdirSync } from "node:fs";

async function listJson(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

async function childPaths(root: string) {
  if (root === "") {
    return [];
  }
  const found = [root, `${root}/b`];
  return found;
}

async function index(names: string[]): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();
  const byName = new Map<string, number>();
  for (const name of names) byName.set(name, name.length);
  return byName;
}

async function unique(words: string[]): Promise<Set<string>> {
  if (words.length === 0) return new Set();
  return new Set<string>(words);
}

const pick = async (flag: boolean) => (flag ? [] : ["a", "b"]);

async function main(): Promise<void> {
  const missing = await listJson("/nonexistent-dir-for-test");
  missing.push("pushed");
  console.log(missing, missing.length);
  console.log(await childPaths(""), await childPaths("/root"));
  const empty = await index([]);
  empty.set("late", 4);
  console.log(empty.size, empty.get("late"), (await index(["ab", "c"])).get("ab"));
  const none = await unique([]);
  none.add("z");
  console.log([...none], [...(await unique(["x", "x", "y"]))]);
  const first = await pick(true);
  first.push("c");
  console.log(first, await pick(false));
}
void main();
