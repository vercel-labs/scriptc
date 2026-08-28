// @dynamic
// An any-typed config is engine-backed in the dynamic tier. The static
// util.parseArgs spoke must snapshot its documented members before parsing.
import { parseArgs } from "node:util";

const config = /** @type {any} */ ({
  args: ["--name=codex", "tail"],
  options: { name: { type: "string" } },
  allowPositionals: true,
  tokens: true,
});

console.log(JSON.stringify(parseArgs(config)));
