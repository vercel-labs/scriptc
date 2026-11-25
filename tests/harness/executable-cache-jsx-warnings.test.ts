/* A build served by the executable cache repeats the warnings the cold build
 * reported, framed at the positions the build located them in. A JSX file is
 * rewritten before lowering, so the file on disk does not hold those
 * positions: the entry keeps the rewritten text its warnings point into, and
 * a hit frames them the way the cold build did. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const windows = process.platform === "win32";

const TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  }
}
`;

const FACTORY = `export function h(tag: any, props: any, ...children: any[]): any {
  return { tag, props, children };
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [name: string]: any;
    }
  }
}
`;

// The cast to an unrelated class is a lowering divergence: a warning without
// a failure, located in the rewritten JSX text.
const PAGE = `import { h } from "./factory.js";

export const view = <div>ok</div>;

class Base {
  kind = 0;
}
class A extends Base {
  kind = 1;
  x = 1;
}
class B extends Base {
  kind = 2;
  x = 2;
}

function read(n: Base): number {
  return (n as A).x;
}

export function trigger(): number {
  return read(new B());
}
`;

const ENTRY = `// @tsc-jsx
import { trigger, view } from "./page.js";
console.log(view, trigger());
`;

let directory = "";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-cache-jsx-warnings-"));
  mkdirSync(join(directory, "program"));
  const program = join(directory, "program");
  writeFileSync(join(program, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(program, "factory.ts"), FACTORY);
  writeFileSync(join(program, "page.tsx"), PAGE);
  writeFileSync(join(program, "main.ts"), ENTRY);
});

afterAll(() => {
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

async function build(): Promise<string> {
  const result = await execFileAsync(
    process.execPath,
    [cli, "build", join(directory, "program", "main.ts"), "-o", join(directory, "main")],
    {
      cwd: repoRoot,
      env: { ...process.env, SCRIPTC_CACHE_DIR: join(directory, "cache") },
      maxBuffer: 1 << 24,
    },
  );
  return result.stderr;
}

/** Every build stamp under the cache root. */
function stamps(root: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...stamps(path));
    else if (entry.name === "stamp.json") {
      try {
        found.push(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
      } catch {
        // Not a build stamp.
      }
    }
  }
  return found;
}

test.skipIf(windows)(
  "a cache hit frames a JSX file's warnings where the build located them",
  { timeout: 600_000 },
  async () => {
    const cold = await build();
    expect(cold).toContain("warning SC6004");
    expect(cold).toContain("return read(new B());");

    // The entry keeps the rewritten text the warning's positions index into.
    // The file on disk holds the same code at other positions, so a hit that
    // read it back would frame the warning elsewhere.
    const page = join(directory, "program", "page.tsx");
    const kept = stamps(join(directory, "cache"))
      .map((stamp) => stamp["warningSources"])
      .filter(
        (sources): sources is Record<string, string> =>
          typeof sources === "object" && sources !== null,
      )
      .map((sources) => sources[page])
      .filter((text): text is string => typeof text === "string");
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toBe(readFileSync(page, "utf8"));
    expect(kept[0]).toContain(`h("div"`);

    const warm = await build();
    expect(warm).toBe(cold);
  },
);
