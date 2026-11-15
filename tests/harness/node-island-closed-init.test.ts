/* Island-closed module-level constants (compiler frontend/lowering/
 * closed-island-init.ts): what the build decides for their generated island
 * modules, and when Node starts in a program that declares them. The
 * programs are corpus programs (their output is compared with Node's
 * there); this file reads the build's deferral trace and the run's boot
 * trace. Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-closed-init");
const skip = libnodePack() === null;

const islandLines = (text: string): string[] =>
  text.split("\n").filter((l) => l.startsWith("[node-islands] "));

/** Builds a corpus program (or the fixture at `entry`) with the build
 * traces on; answers the binary, the deferral decisions (`trace`) and
 * what the build said of each constant (`closed`). */
async function build(
  name: string,
  entry = join(corpus, name, "main.ts"),
  extraEnv: Record<string, string> = {},
): Promise<{ binary: string; trace: string[]; closed: string[] }> {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "main");
  const env = {
    ...process.env,
    SCRIPTC_NODE_ISLANDS_TRACE: "defer,closed",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
    ...extraEnv,
  };
  const { stderr } = await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
    env,
    encoding: "utf8",
  });
  const lines = islandLines(stderr);
  return {
    binary,
    trace: lines.filter((l) => /^\[node-islands\] (defer|eager) /.test(l)),
    closed: lines.filter((l) => /^\[node-islands\] (not )?closed /.test(l)),
  };
}

/** Runs `binary` with the boot trace on; answers its stdout, its boot
 * trace and its exit status. */
async function run(binary: string): Promise<{ stdout: string; boot: string[]; code: number }> {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: join(outDir, "cache"),
    SCRIPTC_NODE_ISLANDS_TRACE: "boot",
  };
  try {
    const { stdout, stderr } = await execFileAsync(binary, [], { env, encoding: "utf8" });
    return { stdout, boot: islandLines(stderr), code: 0 };
  } catch (e) {
    const failed = e as { code?: number; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw e;
    return {
      stdout: failed.stdout ?? "",
      boot: islandLines(failed.stderr ?? ""),
      code: failed.code,
    };
  }
}

/** A decision about a generated module (not one whose reason names one). */
const generated = (line: string): boolean =>
  /^\[node-islands\] \w+ [^:]*\.scriptc\/closed\//.test(line);
const startsNode = (boot: string[]): boolean => boot.some((l) => l.includes("starting Node"));

describe.skipIf(skip)("island-closed module-level constants", () => {
  test("the probe finds its copies when the temporary directory is a link", async () => {
    // The probe loads a generated module from a copy in the temporary
    // directory and Node names a module by its real path. On macOS the
    // temporary directory is under /var, a link to /private/var: a copy
    // known by the linked path was taken for a file of the program, and
    // every constant stayed eager.
    // Outside every node_modules directory, as the system's temporary
    // directory is: the probe never refuses a file under one.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-closed-link-")));
    const real = join(scratch, "real");
    const link = join(scratch, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const { trace } = await build("8910-node-island-closed-const-unused", undefined, {
      TMPDIR: link,
    });
    rmSync(scratch, { recursive: true, force: true });
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(3);
    for (const module of modules)
      expect(module).toMatch(/^\[node-islands\] defer .*recorded evaluation is deterministic/);
  }, 300_000);

  test("unused constants are deferred island modules, and Node never starts", async () => {
    const { binary, trace } = await build("8910-node-island-closed-const-unused");
    const modules = trace.filter(generated);
    // One generated module per constant.
    expect(modules).toHaveLength(3);
    for (const module of modules)
      expect(module).toMatch(/^\[node-islands\] defer .*recorded evaluation is deterministic/);
    const { boot, code } = await run(binary);
    expect(code).toBe(0);
    expect(boot.filter((l) => l.includes("deferred ./.scriptc/closed/"))).toHaveLength(3);
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("primitive constants come from the snapshot without Node", async () => {
    const { binary, trace } = await build("8935-node-island-closed-const-primitive");
    expect(trace.filter(generated).every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("5 true v4.12.1 7\nlibnode mapped: false\n");
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("an exit before any use leaves the constants unevaluated", async () => {
    const { binary } = await build("8920-node-island-closed-const-exit");
    const { boot, code } = await run(binary);
    expect(code).toBe(3);
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("an initializer with effects evaluates where its constant is declared", async () => {
    const { binary, trace } = await build("8918-node-island-closed-const-prints");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(3);
    // The build does not print for the program: the probe withholds the
    // write (console.log swallows the refusal, so the evaluation goes on and
    // the record names the effect), and the two modules that print keep
    // their place. The third names the second and stays with it: a module
    // is not deferred when a load it shares a file with has effects.
    for (const module of modules) expect(module).toMatch(/^\[node-islands\] eager /);
    const printing = modules.filter((l) => /: its evaluation has effects.*process\.stdout/.test(l));
    expect(printing).toHaveLength(2);
    expect(
      modules.filter((l) => l.includes(": a load it shares a file with has effects")),
    ).toHaveLength(1);
    const { stdout } = await run(binary);
    expect(stdout).toBe(
      "before\nshape-kit: making first\nbetween\nshape-kit: making second\nafter 1 2 3\n",
    );
  }, 300_000);

  test.each([
    ["effects", "scriptc-closed-init-effects.stamp", "fs\\.writeFileSync\\(\\)", "stamped true\n"],
    // Opening a file for writing creates it before anything is written.
    [
      "effects-open",
      "scriptc-closed-init-effects-open.stamp",
      "fs\\.openSync\\(\\)",
      "touched true\n",
    ],
  ])(
    "the build does not perform an initializer's effects (%s)",
    async (fixture, file, operation, output) => {
      const stamp = join(tmpdir(), file);
      rmSync(stamp, { force: true });
      try {
        const { binary, trace } = await build(
          fixture,
          join(repoRoot, "tests/fixtures/node-island/closed-init", fixture, "main.ts"),
        );
        // The probe stopped at the call: the file does not exist after the
        // build, and the module evaluates where the constant is declared.
        expect(existsSync(stamp)).toBe(false);
        const modules = trace.filter(generated);
        expect(modules).toHaveLength(1);
        expect(modules[0]).toMatch(
          new RegExp(`^\\[node-islands\\] eager .*${operation}.*which the build does not perform`),
        );
        const { stdout } = await run(binary);
        expect(stdout).toBe(output);
        expect(existsSync(stamp)).toBe(true);
      } finally {
        rmSync(stamp, { force: true });
      }
    },
    300_000,
  );

  test("a refusal the island package catches does not make its fallback the constant", async () => {
    const { binary, trace } = await build("8932-node-island-closed-const-caught-refusal");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(2);
    // The first initializer's package catches the refused read and returns
    // a fallback; the second's lets it through. Both records name the read,
    // and both constants evaluate in the run.
    for (const module of modules)
      expect(module).toMatch(/^\[node-islands\] eager .*fs\.readFileSync\(\)/);
    const { stdout } = await run(binary);
    expect(stdout).toBe("measure twice 14\n");
  }, 300_000);

  test("the build says which constants the island evaluates, and what keeps the others native", async () => {
    const { closed } = await build("8940-node-island-closed-const-mixed");
    const said = closed.map((l) => l.replace(/ \S*\/main\.ts:/, " main.ts:"));
    expect(said).toEqual([
      "[node-islands] not closed main.ts:10 bounded: its initializer holds a constant the island does not evaluate (`limit`)",
      "[node-islands] closed main.ts:11 tags",
      // The change of the island's array is the island's to make too.
      "[node-islands] closed main.ts:12 (statement)",
      "[node-islands] closed main.ts:13 tagged",
      "[node-islands] closed main.ts:14 closed",
    ]);
  }, 300_000);

  test("a constant in a module that is also imported dynamically still waits", async () => {
    const { binary, trace } = await build("8943-node-island-closed-const-shared-dynamic");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatch(/^\[node-islands\] defer .*guarded by the loads before it/);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("start object\nlibnode mapped: false\n");
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("a run that loaded something else first evaluates the constant where it is declared", async () => {
    const { binary, trace } = await build("8942-node-island-closed-const-load-order");
    // The build defers it: in the order the probe evaluated, it is the
    // second load.
    expect(trace.filter(generated)).toHaveLength(1);
    expect(trace.filter(generated)[0]).toMatch(/^\[node-islands\] defer /);
    const { stdout, boot } = await run(binary);
    // This run loads the plugin's package before the constant; the probe
    // had evaluated the constant first. The package's load is the first
    // whose history differs from the probe's: its guard fails, it evaluates
    // at its import and Node starts. The constant, declared after it,
    // evaluates where it is declared and sees what that load did.
    expect(stdout).toBe("start\nplugin plugin\ncount 1 plugin\n");
    expect(
      boot.some((l) => l.includes("boot guard failed: the loads before ./node_modules/plug-kit/")),
    ).toBe(true);
    expect(
      boot.some((l) =>
        /evaluating \.\/\.scriptc\/closed\/.* eagerly: Node is already running/.test(l),
      ),
    ).toBe(true);
  }, 300_000);

  test("constants and statements before the first native use all wait, and the use finds them evaluated", async () => {
    const { binary, trace } = await build("8939-node-island-closed-const-after-call");
    // The package, three constants and the two statements between them.
    expect(trace).toHaveLength(6);
    expect(trace.every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    const { stdout, boot } = await run(binary);
    // The constants are the values the probe computed after the statements
    // before them; the call in the last line starts Node.
    expect(stdout).toBe("empty 0\n1 x,y 2\n");
    expect(boot.filter((l) => l.includes("deferred ./.scriptc/closed/"))).toHaveLength(10);
    expect(boot.filter((l) => l.includes("eagerly"))).toHaveLength(0);
    expect(boot.filter((l) => l.includes("starting Node"))).toHaveLength(1);
  }, 300_000);

  test("a constant declared after Node started evaluates there, not from its snapshot", async () => {
    const { binary, trace } = await build("9349-node-island-closed-stmt-after-use");
    // Every module is deferred by the build; a load reached while Node runs
    // evaluates at its position.
    expect(trace.every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("before 2 0\nafter 4 1\n");
    expect(
      boot.filter((l) =>
        /evaluating \.\/\.scriptc\/closed\/.* eagerly: Node is already running/.test(l),
      ),
    ).toHaveLength(3);
  }, 300_000);
});

describe.skipIf(skip)("island-closed module-level statements", () => {
  const statements = (closed: string[]): string[] =>
    closed.map((l) => l.replace(/ \S*\/main\.ts:/, " main.ts:"));

  test("statements nothing reads are deferred island modules, and Node never starts", async () => {
    const { binary, trace, closed } = await build("9340-node-island-closed-stmt-unused");
    expect(statements(closed)).toEqual([
      "[node-islands] closed main.ts:16 (statement)",
      "[node-islands] closed main.ts:17 (statement)",
      "[node-islands] closed main.ts:18 (statement)",
    ]);
    const modules = trace.filter(generated);
    // One generated module per statement.
    expect(modules).toHaveLength(3);
    for (const module of modules)
      expect(module).toMatch(/^\[node-islands\] defer .*recorded evaluation is deterministic/);
    const { stdout, boot, code } = await run(binary);
    expect(code).toBe(0);
    expect(stdout).toBe("start\nobject object object\nlibnode mapped: false\nend\n");
    expect(boot.filter((l) => l.includes("deferred ./.scriptc/closed/"))).toHaveLength(3);
    expect(startsNode(boot)).toBe(false);
  }, 300_000);

  test("statements and constants wait together, and the first use finds them in the program's order", async () => {
    const { binary, trace } = await build("9342-node-island-closed-stmt-order");
    const modules = trace.filter(generated);
    // early.ts: a statement and a constant; main.ts: three statements and
    // two constants.
    expect(modules).toHaveLength(7);
    for (const module of modules) expect(module).toMatch(/^\[node-islands\] defer /);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe(
      "constants 1 2 early=alpha,one=beta,two=alpha\nlibnode mapped: false\n" +
        "first use early=alpha,one=beta,two=alpha 3 2\n",
    );
    // Node starts once, at the call in the last line, and evaluates the
    // deferred modules in the order they were registered.
    expect(boot.filter((l) => l.includes("starting Node"))).toHaveLength(1);
    const evaluated = boot
      .filter((l) => l.includes("evaluating deferred ./.scriptc/closed/"))
      .map((l) => /closed\/(\w+)\.\w+\.(\d+)\.mjs/.exec(l)!.slice(1, 3).join("."));
    expect(evaluated).toEqual([
      "early.0",
      "early.1",
      "main.0",
      "main.1",
      "main.2",
      "main.3",
      "main.4",
    ]);
    expect(boot.filter((l) => l.includes("eagerly"))).toHaveLength(0);
  }, 300_000);

  test("a statement with effects evaluates where it stands", async () => {
    const { binary, trace } = await build("9343-node-island-closed-stmt-prints");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(3);
    // The build does not print for the program: the two statements that
    // print keep their place. The quiet one between them evaluates in place
    // too: Node is running by then, so the build writes no snapshot of it.
    expect(modules.filter((l) => /^\[node-islands\] eager .*process\.stdout/.test(l))).toHaveLength(
      2,
    );
    expect(
      modules.filter((l) =>
        /^\[node-islands\] eager .*an earlier load evaluates where it is imported/.test(l),
      ),
    ).toHaveLength(1);
    const { stdout } = await run(binary);
    expect(stdout).toBe(
      "before\nplug-kit: registering one\nbetween\nplug-kit: registering three\n" +
        "after one=one,two=alpha,three=three\n",
    );
  }, 300_000);

  test("a statement that changes what a snapshot answers keeps itself and that module eager", async () => {
    const { binary, trace } = await build("9344-node-island-closed-stmt-member");
    // The package's snapshot holds `registry.size`; the first statement's
    // evaluation changes it, so neither is deferred, and the later ones
    // have nothing deferred left to change.
    expect(trace.filter((l) => !generated(l))).toEqual([
      expect.stringMatching(
        /^\[node-islands\] eager .*plug-kit\/index\.js: a later island module's load changes its exports$/,
      ),
    ]);
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(3);
    expect(modules[0]).toMatch(
      /^\[node-islands\] eager .*: its load changes another island module's exports$/,
    );
    const { stdout } = await run(binary);
    expect(stdout).toBe("size 0\nsize 1\nsize 3\n");
  }, 300_000);

  test("a native operand, a function of the program and a used value keep a statement native", async () => {
    const callback = await build("9345-node-island-closed-stmt-callback");
    expect(statements(callback.closed)).toEqual([
      "[node-islands] not closed main.ts:9 (statement): it holds an expression the island cannot take as written (`(name: string) => {`)",
      "[node-islands] closed main.ts:13 (statement)",
      "[node-islands] closed main.ts:15 (statement)",
    ]);
    const ran = await run(callback.binary);
    expect(ran.stdout).toBe(
      "registered alpha 1\nbetween alpha\nregistered beta 2\nafter alpha+beta 2\n",
    );
    const forms = await build("9347-node-island-closed-stmt-forms");
    expect(statements(forms.closed)).toEqual([
      "[node-islands] closed main.ts:9 made",
      "[node-islands] closed main.ts:10 (statement)",
      "[node-islands] closed main.ts:11 (statement)",
      "[node-islands] closed main.ts:12 (statement)",
      "[node-islands] closed main.ts:13 (statement)",
      "[node-islands] closed main.ts:14 (statement)",
      "[node-islands] not closed main.ts:17 (statement): it holds a constant the island does not evaluate (`label`)",
    ]);
    const { stdout } = await run(forms.binary);
    expect(stdout).toBe(
      "gamma=gamma,solo=solo,inline=nested,tag:a=a,tag:b=b,cast=gamma,native=gamma\n7 4\n",
    );
  }, 300_000);

  test("a statement that leaves a rejected promise stays where the program has it", async () => {
    const { trace } = await build(
      "rejected",
      join(repoRoot, "tests/fixtures/node-island/closed-init/rejected/main.ts"),
    );
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(2);
    // The registration before it still waits; in the run it evaluates when
    // the second statement starts Node, ahead of it.
    expect(modules.filter((l) => l.startsWith("[node-islands] defer "))).toHaveLength(1);
    expect(modules.filter((l) => l.startsWith("[node-islands] eager "))).toEqual([
      expect.stringMatching(
        /main\.\w+\.1\.mjs: its load has effects: a promise the load leaves rejected$/,
      ),
    ]);
  }, 300_000);
});

describe.skipIf(skip)("island-closed loops over tables", () => {
  const said = (closed: string[]): string[] =>
    closed.map((l) => l.replace(/ \S*\/main\.ts:/, " main.ts:"));

  test("a loop and the table only it names wait together, and the first use finds every entry", async () => {
    const { binary, trace, closed } = await build("9350-node-island-closed-loop-table");
    expect(said(closed)).toEqual([
      "[node-islands] closed main.ts:16 plugins",
      "[node-islands] closed main.ts:18 (statement)",
    ]);
    const modules = trace.filter(generated);
    // The table and the loop: a generated module each.
    expect(modules).toHaveLength(2);
    for (const module of modules) expect(module).toMatch(/^\[node-islands\] defer /);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe(
      "start\nlibnode mapped: false\nfirst use alpha=alpha,beta=beta,gamma=gamma 3\n",
    );
    expect(boot.filter((l) => l.includes("starting Node"))).toHaveLength(1);
    expect(boot.filter((l) => l.includes("eagerly"))).toHaveLength(0);
  }, 300_000);

  test("loops over names, pairs, keys and values are each one statement of the island", async () => {
    const { binary, trace, closed } = await build("9351-node-island-closed-loop-forms");
    expect(said(closed)).toEqual([
      "[node-islands] closed main.ts:8 names",
      "[node-islands] closed main.ts:9 (statement)",
      "[node-islands] closed main.ts:11 pairs",
      "[node-islands] closed main.ts:15 (statement)",
      "[node-islands] closed main.ts:17 table",
      "[node-islands] closed main.ts:18 (statement)",
      "[node-islands] closed main.ts:19 (statement)",
    ]);
    expect(trace.filter(generated)).toHaveLength(7);
    expect(trace.every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    const { stdout } = await run(binary);
    expect(stdout).toBe(
      "one=alpha,two=alpha,three=alpha,four=beta,five=alpha,six=alpha,again=beta,again=alpha\n8 6\n",
    );
  }, 300_000);

  test("a table the program reads, a body that calls the program, and a `let` binding stay native", async () => {
    const { binary, trace, closed } = await build("9352-node-island-closed-loop-native");
    expect(said(closed)).toEqual([
      "[node-islands] not closed main.ts:9 names: line 11 names it outside the statements the island evaluates",
      "[node-islands] not closed main.ts:10 (statement): it holds a constant the island does not evaluate (`names`)",
      "[node-islands] not closed main.ts:13 more: line 14 names it outside the statements the island evaluates",
      "[node-islands] not closed main.ts:14 (statement): it holds a constant the island does not evaluate (`more`)",
    ]);
    expect(trace.filter(generated)).toHaveLength(0);
    const { stdout } = await run(binary);
    expect(stdout).toBe(
      "names 2\nregistered three\none=alpha,two=alpha,three=alpha,four=alpha 4\n",
    );
  }, 300_000);

  test("a loop with effects runs where it stands; its table still waits for it", async () => {
    const { binary, trace } = await build("9353-node-island-closed-loop-prints");
    const modules = trace.filter(generated);
    expect(modules).toHaveLength(2);
    expect(
      modules.filter((l) => /^\[node-islands\] eager .*\.1\.mjs: .*process\.stdout/.test(l)),
    ).toHaveLength(1);
    expect(modules.filter((l) => /^\[node-islands\] defer .*\.0\.mjs: /.test(l))).toHaveLength(1);
    const { stdout } = await run(binary);
    expect(stdout).toBe(
      "before\nplug-kit: registering one\nplug-kit: registering two\nafter one=one,two=two 2\n",
    );
  }, 300_000);
});
