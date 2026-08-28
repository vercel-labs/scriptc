/* prettier CLI end-to-end: the REAL published prettier (the `prettier`
 * npm package, unmodified) runs its actual CLI workflows under Node
 * (bin/prettier.cjs — the acceptance oracle) AND as a scriptc --dynamic
 * binary; stdout, stderr, exit codes, and every written file's bytes
 * must agree. The driver imports the package's own CLI module
 * (internal/legacy-cli.mjs, exported via the package's "./*" pattern)
 * and calls run() — exactly what bin/prettier.cjs does after its
 * please-upgrade-node preamble. The whole package executes in the
 * island; the acceptance surface leans on the island's fs (config
 * discovery walks, --write), process.stdin (the get-stdin path), argv,
 * exit codes, and the v8 startupSnapshot probe prettier's bundled error
 * helpers make on every start.
 *
 * No network: prettier's CLI is fully offline (no update checks, no
 * telemetry), so there is no jail — nothing to escape to.
 *
 * SETUP (the suite SKIPS when the scratch install is absent):
 *   mkdir -p ~/Developer/prettier-scratch && cd ~/Developer/prettier-scratch
 *   npm init -y && npm i prettier@3.9.5
 * SCRIPTC_PRETTIER_ROOT overrides the location. No output snapshots are
 * committed — every assertion is Node-vs-native at run time — so a newer
 * prettier keeps the suite honest as long as both lanes share the install.
 *
 * NORMALIZATIONS (both lanes, byte-exact otherwise): the per-file elapsed
 * "12ms" → "<T>" in --write/--check listings (wall-clock), and the lane
 * cwd → "<CWD>". --file-info compares parsed JSON structurally (the
 * documented object key-order divergence, SEMANTICS 16/37). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const executionTag = [
  sanitize ? "san" : "plain",
  process.env["SCRIPTC_TEST_RUN_ID"] ?? `pid-${process.pid}`,
  process.env["SCRIPTC_TEST_SHARD"] ?? "all",
]
  .join("-")
  .replace(/[^a-zA-Z0-9_.-]+/g, "-");

const prettierRoot = process.env["SCRIPTC_PRETTIER_ROOT"] ?? join(homedir(), "Developer/prettier-scratch");
const prettierPkg = join(prettierRoot, "node_modules/prettier");
const cliEntry = join(prettierPkg, "internal/legacy-cli.mjs");
const binEntry = join(prettierPkg, "bin/prettier.cjs");
const havePrettier = existsSync(cliEntry) && existsSync(binEntry);

let driverBinary = "";
let driverDir = "";
let driverOutDir = "";

/* ── driver generation + build ───────────────────────────────────────── */

const DRIVER_ENTRY = `/// <reference path="./prettier-cli.d.ts" />
import { run } from "prettier/internal/legacy-cli.mjs";

async function main(): Promise<void> {
  await run();
}
void main();
`;

/** The CLI module ships no declarations (the package's types cover the
 * API entry only); this ambient module is the driver's whole type
 * surface for it. */
const DRIVER_AMBIENT = `declare module "prettier/internal/legacy-cli.mjs" {
  export function run(argv?: string[]): Promise<void>;
}
`;

const DRIVER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      allowJs: true,
    },
  },
  null,
  2,
);

function hashInputs(): string {
  const hash = createHash("sha256");
  hash.update(DRIVER_ENTRY).update(DRIVER_AMBIENT).update(DRIVER_TSCONFIG);
  const inputs = [
    ...globSync(join(prettierPkg, "**/*.{js,cjs,mjs,json}")),
  ].sort();
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  return hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
}

async function buildDriver(): Promise<string> {
  // realpath: macOS's tmpdir is a symlink (/var → /private/var), and Node
  // resolves the entry at its REAL path.
  driverDir = join(realpathSync(tmpdir()), `scriptc-prettier-e2e-driver-${executionTag}`);
  rmSync(driverDir, { recursive: true, force: true });
  mkdirSync(driverDir, { recursive: true });
  writeFileSync(join(driverDir, "main.ts"), DRIVER_ENTRY);
  writeFileSync(join(driverDir, "prettier-cli.d.ts"), DRIVER_AMBIENT);
  writeFileSync(join(driverDir, "tsconfig.json"), DRIVER_TSCONFIG);
  writeFileSync(join(driverDir, "package.json"), JSON.stringify({ name: "prettier-e2e-driver", type: "module" }));
  // The bare "prettier/…" specifier resolves through the scratch install.
  symlinkSync(join(prettierRoot, "node_modules"), join(driverDir, "node_modules"));
  const key = hashInputs();
  driverOutDir = join(cacheDir, `prettier-e2e-${key}-${executionTag}`);
  const binary = join(driverOutDir, "program");
  mkdirSync(driverOutDir, { recursive: true });
  const result = await compile(join(driverDir, "main.ts"), {
    outPath: binary,
    outDir: driverOutDir,
    sanitize,
    dynamic: true,
  });
  if (!result.ok) {
    throw new Error(
      "prettier e2e driver failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return binary;
}

/* ── the two lanes ───────────────────────────────────────────────────── */

interface LaneResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  cwd: string;
}

interface RunOptions {
  /** Piped into the child and closed; omitted → closed immediately. */
  stdin?: string;
  /** name → content, written into the lane's scratch cwd before spawning. */
  files?: Record<string, string>;
}

function runLane(cmd: string, cmdArgs: string[], args: string[], opts: RunOptions): Promise<LaneResult> {
  const cwd = mkdtempSync(join(tmpdir(), "scr-prettier-e2e-"));
  const home = join(cwd, "scratch-home");
  mkdirSync(home);
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(cwd, name), content);
  }
  // Minimal env, built from scratch: a scratch HOME (config/editorconfig
  // discovery walks up from the input file and stops inside the scratch
  // cwd's tmpdir anyway, but a clean HOME keeps ~/.config/prettier out),
  // NO_COLOR for both lanes, and Node's compile cache off so the oracle
  // leaves the scratch install pristine.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: home,
    TZ: "UTC",
    NO_COLOR: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, [...cmdArgs, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.stderr.on("data", (c: Buffer) => err.push(c));
    if (opts.stdin === undefined) p.stdin.end();
    else p.stdin.end(opts.stdin);
    p.on("error", reject);
    p.on("close", (code, signal) => {
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code, signal, cwd });
    });
  });
}

function normalize(buf: Buffer, cwd: string): string {
  let text = buf
    .toString("utf8")
    .replaceAll(cwd, "<CWD>")
    .replace(/ \d+ms/g, " <T>");
  if (sanitize) {
    text = text
      .replace(/==\d+==WARNING: ASan is ignoring requested __asan_handle_no_return[^\n]*\n/g, "")
      .replace(/False positive error reports may follow\n/g, "")
      .replace(/For details see https:\/\/github\.com\/google\/sanitizers\/issues\/189\n/g, "");
  }
  return text;
}

/** Every file under the lane cwd (the scratch HOME excluded): relative
 * name → bytes. Pins --write's output files. */
function filesOf(cwd: string): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === "" && name === "scratch-home") continue;
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else map.set(rel, readFileSync(full));
    }
  };
  walk(cwd, "");
  return map;
}

async function runBoth(args: string[], opts: RunOptions = {}): Promise<{ node: LaneResult; native: LaneResult }> {
  const [nodeRes, nativeRes] = await Promise.all([
    runLane(process.execPath, [binEntry], args, opts),
    runLane(driverBinary, [], args, opts),
  ]);
  const label = args.join(" ");
  try {
    if (args.includes("--file-info")) {
      expect(
        JSON.parse(normalize(nativeRes.stdout, nativeRes.cwd)),
        `parsed --file-info stdout of: ${label}`,
      ).toEqual(JSON.parse(normalize(nodeRes.stdout, nodeRes.cwd)));
    } else {
      expect(normalize(nativeRes.stdout, nativeRes.cwd), `stdout of: ${label}`).toBe(
        normalize(nodeRes.stdout, nodeRes.cwd),
      );
    }
    expect(normalize(nativeRes.stderr, nativeRes.cwd), `stderr of: ${label}`).toBe(
      normalize(nodeRes.stderr, nodeRes.cwd),
    );
    expect(nativeRes.code, `exit code of: ${label}`).toBe(nodeRes.code);
    expect(nativeRes.signal, `signal of: ${label}`).toBe(nodeRes.signal);
    const nodeFiles = filesOf(nodeRes.cwd);
    const nativeFiles = filesOf(nativeRes.cwd);
    expect([...nativeFiles.keys()], `files of: ${label}`).toEqual([...nodeFiles.keys()]);
    for (const [name, bytes] of nodeFiles) {
      expect(nativeFiles.get(name)!.equals(bytes), `bytes of ${name} for: ${label}`).toBe(true);
    }
  } finally {
    rmSync(nodeRes.cwd, { recursive: true, force: true });
    rmSync(nativeRes.cwd, { recursive: true, force: true });
  }
  return { node: nodeRes, native: nativeRes };
}

/* ── sample sources (deliberately unformatted) ───────────────────────── */

const SAMPLE_JS = "const x={a:1,b:[1,2,3],c:'str'}\nfunction  f( a,b ){return a+ b}\n";
const SAMPLE_TS = "interface X{a:number,b:string[]}\nconst   f=(x:X):string=>{return x.b.join(',')+String(x.a)}\nexport{f}\n";
const SAMPLE_JSON = '{"b":2,"a":[1,2,   3],"c":{"d":null}}';
const SAMPLE_MD = "# title\n\nsome  *text* and a [link](http://x.example)\n\n* a\n* b\n";
const SAMPLE_CSS = ".cls{color:red;margin:0 0 0 0}\n#id  ,  .other{display:flex}\n";
const SAMPLE_YAML = "a:   1\nlist:\n  - x\n  - 'y'\n";
const FORMATTED_JS = 'const x = { a: 1, b: [1, 2, 3], c: "str" };\n';
const BROKEN_JS = "const = {;\n";

/* ── the suite ───────────────────────────────────────────────────────── */

describe.skipIf(!havePrettier)(`prettier e2e (real published CLI vs Node${sanitize ? ", sanitized" : ""})`, () => {
  beforeAll(async () => {
    driverBinary = await buildDriver();
  }, 300_000);

  afterAll(() => {
    rmSync(driverDir, { recursive: true, force: true });
    rmSync(driverOutDir, { recursive: true, force: true });
  });

  test("version, help, and usage errors", async () => {
    await runBoth(["--version"]);
    await runBoth(["--help"]);
    await runBoth(["--help", "write"]);
    await runBoth(["--bogus-flag"]); // unknown option + no input: exit 2
    await runBoth(["nonexistent.js"]); // no matching files: exit 2
  });

  test("formatting to stdout across parsers", async () => {
    await runBoth(["--parser=babel", "sample.js"], { files: { "sample.js": SAMPLE_JS } });
    await runBoth(["sample.ts"], { files: { "sample.ts": SAMPLE_TS } });
    await runBoth(["sample.json"], { files: { "sample.json": SAMPLE_JSON } });
    await runBoth(["sample.md"], { files: { "sample.md": SAMPLE_MD } });
    await runBoth(["sample.css"], { files: { "sample.css": SAMPLE_CSS } });
    await runBoth(["sample.yaml"], { files: { "sample.yaml": SAMPLE_YAML } });
  });

  test("check, list-different, and write", async () => {
    await runBoth(["--check", "formatted.js"], { files: { "formatted.js": FORMATTED_JS } }); // exit 0
    await runBoth(["--check", "sample.js"], { files: { "sample.js": SAMPLE_JS } }); // exit 1
    await runBoth(["--list-different", "sample.js"], { files: { "sample.js": SAMPLE_JS } });
    await runBoth(["--write", "sample.js"], { files: { "sample.js": SAMPLE_JS } }); // rewrites in place
    await runBoth(["--write", "formatted.js"], { files: { "formatted.js": FORMATTED_JS } }); // "(unchanged)"
  });

  test("stdin formatting", async () => {
    await runBoth(["--parser=babel"], { stdin: SAMPLE_JS });
    await runBoth(["--stdin-filepath", "foo.ts"], { stdin: SAMPLE_TS });
    await runBoth(["--parser=json"], { stdin: SAMPLE_JSON });
    await runBoth(["--parser=babel"], { stdin: "" }); // empty stdin: empty doc out
  });

  test("options, config discovery, and file-info", async () => {
    await runBoth(["--no-semi", "--single-quote", "sample.js"], { files: { "sample.js": SAMPLE_JS } });
    await runBoth(["--tab-width", "7", "sample.js"], { files: { "sample.js": SAMPLE_JS } });
    // .prettierrc in the lane cwd: the island's fs walks and finds it.
    await runBoth(["sample.js"], {
      files: { "sample.js": SAMPLE_JS, ".prettierrc": '{ "semi": false, "singleQuote": true }' },
    });
    await runBoth(["--no-config", "sample.js"], {
      files: { "sample.js": SAMPLE_JS, ".prettierrc": '{ "semi": false }' },
    });
    await runBoth(["--find-config-path", "sample.js"], {
      files: { "sample.js": SAMPLE_JS, ".prettierrc": "{}" },
    });
    await runBoth(["--file-info", "sample.js"], { files: { "sample.js": SAMPLE_JS } });
  });

  test("parse errors and exit codes", async () => {
    await runBoth(["broken.js"], { files: { "broken.js": BROKEN_JS } }); // syntax error: exit 2
    await runBoth(["--check", "broken.js"], { files: { "broken.js": BROKEN_JS } });
    await runBoth(["--parser=babel"], { stdin: BROKEN_JS }); // stdin syntax error
  });
});
