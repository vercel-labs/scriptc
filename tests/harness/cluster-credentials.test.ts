/* A cluster worker's credentials cannot be dropped before exec on this
 * runtime: the launch re-executes the artifact, which runs the dynamic
 * loader with the primary's identity before any runtime code could drop
 * privileges. cluster.fork() therefore refuses a credentialed
 * setupPrimary instead of treating the drop as enforced. The program below
 * prints the refusal; before the refusal existed it printed "forked" and
 * left the credential drop to the worker. */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const cacheDir = join(
  repoRoot,
  "node_modules/.cache/scriptc-tests/cluster-credentials",
  sanitize ? "san" : "plain",
);

/* Node's setupPrimary merge is an object spread: it reads the options'
 * own enumerable properties through ordinary property access, so an own
 * accessor runs its getter and the merged settings hold the value it
 * answers. A Proxy answers through its ownKeys and get traps, and an
 * inherited accessor is not an own property. */
const forkProgram = (settings: string) => `import * as cluster from "node:cluster";

if (cluster.isPrimary) {
  const settings: any = ${settings};
  cluster.setupPrimary(settings);
  try {
    cluster.fork();
    console.log("forked");
  } catch (error) {
    console.log("refused", (error as { code?: string }).code);
  }
}
`;

const mergeProgram = (settings: string) => `import * as cluster from "node:cluster";

const settings: any = ${settings};
cluster.setupPrimary(settings);
console.log("merged", cluster.settings.uid);
`;

async function runSource(name: string, source: string): Promise<string> {
  const outDir = join(cacheDir, name);
  mkdirSync(outDir, { recursive: true });
  const sourcePath = join(outDir, "main.ts");
  writeFileSync(sourcePath, source);
  const result = await compile(sourcePath, {
    outPath: join(outDir, "program"),
    outDir,
    backend: "llvm",
    sanitize,
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const run = await execFileAsync(result.binaryPath, [], { timeout: 30_000 });
  return run.stdout.trim();
}

test.skipIf(process.platform === "win32")(
  "a credentialed cluster launch is refused before it runs the artifact",
  async () => {
    expect(await runSource("refused", forkProgram("{ uid: 65534, gid: 65534 }"))).toBe(
      "refused SC2020",
    );
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a uid supplied by a getter is read by the merge and refused",
  async () => {
    expect(await runSource("getter-uid", forkProgram("{ get uid() { return 0; } }"))).toBe(
      "refused SC2020",
    );
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a uid supplied by an own accessor property is read by the merge and refused",
  async () => {
    const source = forkProgram(`(() => {
  const options: any = {};
  Object.defineProperty(options, "uid", {
    get() {
      return 0;
    },
    enumerable: true,
    configurable: true,
  });
  return options;
})()`);
    expect(await runSource("own-accessor-uid", source)).toBe("refused SC2020");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a uid supplied through a Proxy trap is read by the merge and refused",
  async () => {
    const source = forkProgram(`(() => {
  const target: any = {};
  Object.defineProperty(target, "uid", {
    get() {
      return 0;
    },
    enumerable: true,
    configurable: true,
  });
  return new Proxy(target, {
    get(t: any, key: any) {
      return t[key];
    },
  });
})()`);
    expect(await runSource("proxy-uid", source)).toBe("refused SC2020");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a uid supplied by a getter on a function settings value is refused",
  async () => {
    const source = forkProgram(`(() => {
  function settings() {}
  Object.defineProperty(settings, "uid", {
    get() {
      return 0;
    },
    enumerable: true,
    configurable: true,
  });
  return settings;
})()`);
    expect(await runSource("function-uid", source)).toBe("refused SC2020");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a uid supplied by a getter on an array settings value is refused",
  async () => {
    const source = forkProgram(`(() => {
  const settings: any[] = [];
  Object.defineProperty(settings, "uid", {
    get() {
      return 0;
    },
    enumerable: true,
    configurable: true,
  });
  return settings;
})()`);
    expect(await runSource("array-uid", source)).toBe("refused SC2020");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "an inherited accessor is not an own property of the merged settings",
  async () => {
    const source = mergeProgram(`(() => {
  const proto: any = {};
  Object.defineProperty(proto, "uid", {
    get() {
      return 0;
    },
    enumerable: true,
    configurable: true,
  });
  return Object.create(proto);
})()`);
    expect(await runSource("inherited-uid", source)).toBe("merged undefined");
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a class prototype accessor is not an own property of the merged settings",
  async () => {
    const source = mergeProgram(`new (class Settings {
  get uid(): number {
    return 0;
  }
})()`);
    expect(await runSource("class-uid", source)).toBe("merged undefined");
  },
  120_000,
);
