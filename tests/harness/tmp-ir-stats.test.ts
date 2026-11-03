/* TEMPORARY debug (drop before merge): fingerprints the IR the compiler
 * lowers for the self-hosting LLVM emitter, so this branch's lowering can be
 * compared against main's. Prints one `IR STATS` line per run; the plain lane
 * of shard 1/20 runs it once (see the SCRIPTC_SAN / skipUnownedTest gates). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, test } from "vitest";
import { deserializeModule } from "@scriptc/compiler";
import { everyExprChild, everyStmtChild } from "../../packages/compiler/src/ir/traverse.js";
import type { IrExpr, IrModule, IrStmt } from "../../packages/compiler/src/ir/ir.js";
import { skipUnownedTest } from "./shard.js";

const title = "TEMPORARY: self-hosting emitter IR fingerprint";
const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = join(root, "tests/fixtures/self-hosting/llvm-emitter.ts");

interface Walked {
  depth: number;
  nodes: number;
}

function walk(root: IrStmt[]): Walked {
  // Iterative: the seed IR is deeper than a recursive walk can safely visit.
  const stack: { node: IrExpr | IrStmt; depth: number; stmt: boolean }[] = [];
  for (const statement of root) stack.push({ node: statement, depth: 1, stmt: true });
  let depth = 0;
  let nodes = 0;
  while (stack.length > 0) {
    const { node, depth: at, stmt } = stack.pop()!;
    nodes++;
    if (at > depth) depth = at;
    const expr = (child: IrExpr): true => {
      stack.push({ node: child, depth: at + 1, stmt: false });
      return true;
    };
    const inner = (child: IrStmt): true => {
      stack.push({ node: child, depth: at + 1, stmt: true });
      return true;
    };
    if (stmt) everyStmtChild(node as IrStmt, expr, inner);
    else everyExprChild(node as IrExpr, expr, inner);
  }
  return { depth, nodes };
}

function fingerprint(mod: IrModule): void {
  const whole = walk(mod.functions.flatMap((fn) => fn.body));
  const perFunction = mod.functions
    .map((fn) => ({ name: fn.name, ...walk(fn.body) }))
    .sort((a, b) => b.depth - a.depth || b.nodes - a.nodes);
  console.log(
    `IR STATS functions=${mod.functions.length} nodes=${whole.nodes} depth=${whole.depth}`,
  );
  for (const fn of perFunction.slice(0, 12))
    console.log(`IR STATS fn depth=${fn.depth} nodes=${fn.nodes} ${fn.name}`);
}

describe(title, () => {
  beforeEach((context) => skipUnownedTest(context, { [title]: 300_000 }));

  test(
    title,
    () => {
      // The sanitizer lane compiles the same IR, so one plain run suffices.
      if (process.env["SCRIPTC_SAN"] === "1") return;
      const dir = mkdtempSync(join(tmpdir(), "scriptc-ir-stats-"));
      try {
        const api = pathToFileURL(join(root, "packages/compiler/src/index.ts")).href;
        const stdout = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            `import { compile } from ${JSON.stringify(api)};
             const result = await compile(process.argv[1], {
               outDir: process.argv[2], outPath: process.argv[3],
               backend: "llvm", optimization: "dev", sanitize: false, emitIr: true,
             });
             if (!result.ok) {
               console.error(JSON.stringify(result.diagnostics));
               process.exit(1);
             }
             console.log(JSON.stringify({ ir: result.irPath, llvm: result.llvmPath }));`,
            entry,
            dir,
            join(dir, "emitter"),
          ],
          { cwd: root, timeout: 1_800_000, encoding: "utf8" },
        );
        const paths = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
          ir: string;
          llvm: string;
        };
        const raw = readFileSync(paths.ir, "utf8");
        // The checkout root and the temporary output directory are the only
        // parts of the text that differ between two checkouts of the same
        // sources, and the natively emitted paths are not part of the IR.
        const text = raw.replaceAll(root, "<ROOT>").replaceAll(dir, "<DIR>");
        const hash = createHash("sha256").update(text).digest("hex");
        const pathBytes = raw.length - text.length;
        console.log(`IR STATS sha256=${hash} bytes=${text.length} pathBytes=${pathBytes}`);
        const llvmRaw = readFileSync(paths.llvm, "utf8");
        const llvm = llvmRaw.replaceAll(root, "<ROOT>").replaceAll(dir, "<DIR>");
        const defines = llvm
          .split("\n")
          .filter((line) => line.startsWith("define "))
          .sort()
          .join("\n");
        console.log(
          `IR STATS llvm sha256=${createHash("sha256").update(llvm).digest("hex")}` +
            ` lines=${llvm.split("\n").length}` +
            ` defines=${defines.length === 0 ? 0 : defines.split("\n").length}` +
            ` definesSha256=${createHash("sha256").update(defines).digest("hex")}`,
        );
        fingerprint(deserializeModule(raw));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    1_800_000,
  );
});
