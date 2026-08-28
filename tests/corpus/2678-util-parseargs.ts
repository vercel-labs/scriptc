// Static node:util.parseArgs — Node is the oracle for grammar, defaults,
// negative booleans, tokens, and coded error paths.
import { parseArgs } from "node:util";

const full = parseArgs({
  args: ["-v", "--output=result.txt", "--tag", "a", "--tag=b", "file", "--", "--literal"],
  options: {
    verbose: { type: "boolean", short: "v" },
    output: { type: "string", short: "o" },
    tag: { type: "string", short: "t", multiple: true },
    color: { type: "boolean", default: true },
  },
  allowPositionals: true,
  tokens: true,
});
console.log("full", JSON.stringify(full));
const { values: fullValues, positionals: fullPositionals } = full;
console.log("destructured", fullValues.verbose, fullPositionals.length);
const { values: { output: nestedOutput } } = full;
console.log("nested", nestedOutput);
function printParsed({ values }: ReturnType<typeof parseArgs>): void {
  console.log("param-pattern", values["output"]);
}
printParsed(full);
if (full.tokens !== undefined) {
  const firstToken = full.tokens[0];
  if (firstToken !== undefined && firstToken.kind === "option") {
    console.log("first-token", firstToken.name, firstToken.rawName);
    const { name: tokenName, rawName: tokenRawName } = firstToken;
    console.log("token-pattern", tokenName, tokenRawName);
  }
  for (const { kind } of full.tokens) {
    console.log("loop-pattern", kind);
    break;
  }
}

const clustered = parseArgs({
  args: ["-abVALUE", "--color", "--no-color", "tail"],
  options: {
    all: { type: "boolean", short: "a" },
    build: { type: "string", short: "b" },
    color: { type: "boolean", multiple: true },
  },
  allowNegative: true,
  allowPositionals: true,
  tokens: true,
});
console.log("cluster", JSON.stringify(clustered));

const explicitNegative = parseArgs({
  args: ["--no-x"],
  options: { "no-x": { type: "boolean" } },
  allowNegative: true,
  tokens: true,
});
console.log("explicit-negative", JSON.stringify(explicitNegative));

const loose = parseArgs({
  args: ["--mystery=x", "-qz", "--=odd", "pos"],
  strict: false,
  tokens: true,
});
console.log("loose", JSON.stringify(loose));
console.log("equals-1", JSON.stringify(parseArgs({
  args: ["--==x"],
  strict: false,
  tokens: true,
})));
console.log("equals-2", JSON.stringify(parseArgs({
  args: ["--=x=y"],
  strict: false,
  tokens: true,
})));
console.log("empty-negative-loose", JSON.stringify(parseArgs({
  args: ["--no-"],
  strict: false,
  allowNegative: true,
  tokens: true,
})));
console.log("empty-negative-strict", JSON.stringify(parseArgs({
  args: ["--no-"],
  options: { "": { type: "boolean" } },
  allowNegative: true,
  tokens: true,
})));

const typedConfig: import("node:util").ParseArgsConfig = {
  args: ["--mode", "fast"],
  options: { mode: { type: "string" } },
  tokens: true,
};
console.log("typed", JSON.stringify(parseArgs(typedConfig)));
console.log("undefined", JSON.stringify(parseArgs(undefined)));

// A one-character long name is also its implicit short spelling. Node only
// consults an explicit `short` alias first, then falls back to the name.
console.log("implicit-short", JSON.stringify(parseArgs({
  args: ["-x"],
  options: { x: { type: "boolean" } },
  tokens: true,
})));

// Defaults are assigned, not cloned: result.values keeps the exact array
// reference and observes later mutations through either alias.
const defaultTags = ["fallback"];
const withArrayDefault = parseArgs({
  args: [],
  options: {
    tag: { type: "string", multiple: true, default: defaultTags },
  },
} as const);
const returnedTags = withArrayDefault.values.tag as string[];
console.log("default-array-identity", returnedTags === defaultTags);
defaultTags.push("later");
console.log("default-array-live", JSON.stringify(returnedTags));

for (const run of [
  (): void => { parseArgs({ args: ["--name"], options: { name: { type: "string" } } }); },
  (): void => { parseArgs({ args: ["--wat"] }); },
  (): void => { parseArgs({ args: ["position"] }); },
  (): void => { parseArgs({ args: ["--name", "--next"], options: { name: { type: "string" } } }); },
  (): void => { parseArgs({ args: ["-n", "-1"], options: { name: { type: "string", short: "n" } } }); },
  (): void => { parseArgs({ args: ["tail"], strict: false, allowPositionals: false }); },
  (): void => { parseArgs({ args: ["--", "tail"] }); },
  (): void => { parseArgs({ args: ["--wat"], allowPositionals: true }); },
  (): void => { parseArgs({ args: ["--name"], options: { name: { type: "string", short: "n" } } }); },
  (): void => { parseArgs({ args: ["--force=yes"], options: { force: { type: "boolean", short: "f" } } }); },
  (): void => { parseArgs({ args: ["--no-color=yes"], options: { color: { type: "boolean" } }, allowNegative: true }); },
]) {
  try {
    run();
  } catch (error) {
    if (error instanceof TypeError) {
      console.log("error", `${(error as NodeJS.ErrnoException).code}`, error.message);
    }
  }
}

process.argv.push("--live-flag");
console.log("live-argv", JSON.stringify(parseArgs({
  options: { "live-flag": { type: "boolean" } },
})));
process.argv.pop();
