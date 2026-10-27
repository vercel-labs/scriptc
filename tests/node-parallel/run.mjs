// Builds Node's test/parallel files with scriptc and runs them next to Node.
// See README.md for the options.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sameTermination, termination } from "./verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const { values } = parseArgs({
  options: {
    node: { type: "string" },
    pattern: { type: "string" },
    common: { type: "string", default: "minimal" },
    out: { type: "string", default: join(repo, "node_modules/.cache/scriptc-node-parallel") },
    cli: { type: "string", default: join(repo, "packages/cli/dist/main.js") },
    jobs: { type: "string", default: "4" },
  },
});
if (!values.node || !values.pattern || !["minimal", "node"].includes(values.common)) {
  console.error(
    "usage: node tests/node-parallel/run.mjs --node <node checkout> --pattern <regex> [--common minimal|node] [--out <dir>] [--cli <scriptc main.js>] [--jobs <n>]",
  );
  process.exit(2);
}
// Absolute, so the minimal lane's fixtures symlink resolves from the tree.
const nodeRoot = resolve(values.node);
const nodeTest = existsSync(join(nodeRoot, "test", "parallel")) ? join(nodeRoot, "test") : nodeRoot;
const pattern = new RegExp(values.pattern);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

// The minimal lane copies the selected files into a tree whose test/common is
// this directory's index.cjs and wpt.cjs, next to the checkout's fixtures and
// common/fixtures.js.
let testRoot = nodeTest;
const files = readdirSync(join(nodeTest, "parallel"))
  .filter((name) => name.endsWith(".js") && pattern.test(name))
  .sort();
if (values.common === "minimal") {
  testRoot = join(out, "tree", "test");
  rmSync(join(out, "tree"), { recursive: true, force: true });
  mkdirSync(join(testRoot, "parallel"), { recursive: true });
  mkdirSync(join(testRoot, "common"), { recursive: true });
  for (const name of files)
    cpSync(join(nodeTest, "parallel", name), join(testRoot, "parallel", name));
  symlinkSync(join(nodeTest, "fixtures"), join(testRoot, "fixtures"));
  cpSync(join(nodeTest, "common", "fixtures.js"), join(testRoot, "common", "fixtures.js"));
  cpSync(join(here, "common", "index.cjs"), join(testRoot, "common", "index.js"));
  cpSync(join(here, "common", "wpt.cjs"), join(testRoot, "common", "wpt.js"));
}

function run(cmd, args, opts) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr });
    });
  });
}

const firstCause = (text) =>
  (
    text.split("\n").find((line) => /error|Error|assert|SC\d{4}/.test(line)) ??
    text.split("\n")[0] ??
    ""
  )
    .replaceAll(testRoot, "test")
    .trim()
    .slice(0, 300);

async function one(file) {
  const dir = join(testRoot, "parallel");
  const source = readFileSync(join(dir, file), "utf8");
  const flags = (/^\/\/ Flags: (.*)$/m.exec(source)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const node = await run(process.execPath, [...flags, file], { cwd: dir, timeout: 120_000 });
  const exe = join(out, "bin", `${file}.exe`);
  mkdirSync(join(out, "bin"), { recursive: true });
  const build = await run(process.execPath, [values.cli, "build", file, "-o", exe], {
    cwd: dir,
    timeout: 900_000,
  });
  const result = { file, flags: flags.join(" "), nodeExit: termination(node) };
  if (build.code !== 0) {
    result.verdict = "refused";
    result.cause = firstCause(build.stdout + build.stderr);
    return result;
  }
  const native = await run(exe, [], { cwd: dir, timeout: 120_000 });
  result.exit = termination(native);
  result.verdict = sameTermination(node, native) ? "pass" : "fail";
  if (result.verdict !== "pass") result.cause = firstCause(native.stderr + native.stdout);
  return result;
}

const results = [];
const queue = [...files];
await Promise.all(
  Array.from({ length: Number(values.jobs) }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const result = await one(file);
      results.push(result);
      console.log(`${result.verdict.padEnd(8)} ${file}${result.cause ? `  ${result.cause}` : ""}`);
    }
  }),
);
results.sort((a, b) => (a.file < b.file ? -1 : 1));
const count = (verdict) => results.filter((r) => r.verdict === verdict).length;
const table = [
  "| file | verdict | first cause |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.file} | ${r.verdict} | ${(r.cause ?? "").replaceAll("|", "\\|")} |`),
  "",
  `pass ${count("pass")}, fail ${count("fail")}, refused ${count("refused")} of ${results.length} (test/common: ${values.common})`,
];
writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(join(out, "results.md"), `${table.join("\n")}\n`);
console.log(table.at(-1));
