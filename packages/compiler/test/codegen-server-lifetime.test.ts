import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { nativeCodegenTarget, nativeHelperForTarget } from "../src/backend/targets.js";

const target = nativeCodegenTarget();
const helperSpec = target === null ? null : nativeHelperForTarget(target);
const helper = (() => {
  if (helperSpec === null || process.platform === "win32") return null;
  try {
    const packageJson = createRequire(import.meta.url).resolve(
      `${helperSpec.packageName}/package.json`,
    );
    const executable = join(dirname(packageJson), "bin", "scriptc-llvm-codegen");
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
})();

const dirs: string[] = [];
const processes: { kill(signal?: NodeJS.Signals): boolean }[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A module whose optimization takes tens of seconds: many functions, each a
 * loop the optimizer unrolls and simplifies. */
function slowModule(functions: number): string {
  const lines: string[] = [];
  for (let index = 0; index < functions; index++)
    lines.push(
      `define i64 @f${index}(i64 %n) {`,
      "entry:",
      "  br label %loop",
      "loop:",
      "  %i = phi i64 [0, %entry], [%next, %loop]",
      "  %acc = phi i64 [0, %entry], [%sum, %loop]",
      `  %m = mul i64 %i, ${index + 3}`,
      "  %x = xor i64 %m, %acc",
      "  %sum = add i64 %x, %n",
      "  %next = add i64 %i, 1",
      "  %done = icmp eq i64 %next, 64",
      "  br i1 %done, label %exit, label %loop",
      "exit:",
      "  ret i64 %sum",
      "}",
    );
  return `${lines.join("\n")}\n`;
}

/** A stand-in for a build driver: connects to the server, sends one request
 * the way a native build does, says so, and waits for the answer. */
const DRIVER = `
const { connect } = require("node:net");
const [socket, cwd, ...args] = process.argv.slice(1);
const attempt = () => {
  const connection = connect(socket);
  connection.once("error", () => setTimeout(attempt, 25));
  connection.once("connect", () => {
    const directory = Buffer.from(cwd, "utf8");
    connection.write(Buffer.concat([
      Buffer.from("SCGEN1 " + args.length + " " + directory.length + "\\n", "utf8"),
      directory,
      ...args.flatMap((arg) => {
        const bytes = Buffer.from(arg, "utf8");
        return [Buffer.from(bytes.length + "\\n", "utf8"), bytes];
      }),
    ]));
    process.stdout.write("sent\\n");
    connection.on("data", () => {});
  });
};
attempt();
`;

function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) =>
    child.exitCode !== null || child.signalCode !== null
      ? resolve(child.exitCode)
      : child.once("exit", (code) => resolve(code)),
  );
}

describe.runIf(helper !== null)("the code generation server", () => {
  test("exits when the build it is answering is killed mid-request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-server-lifetime-"));
    dirs.push(dir);
    const input = join(dir, "slow.ll");
    await writeFile(input, slowModule(40_000));
    const socket = join(dir, "server.sock");
    const server = spawn(helper!, ["serve", "--socket", socket, "--idle-exit", "600"], {
      stdio: "ignore",
    });
    processes.push(server);
    const serverExit = exitOf(server);
    const args = [
      "emit",
      "--input",
      input,
      "--output",
      join(dir, "slow.0.o"),
      "--output",
      join(dir, "slow.1.o"),
      "--filetype",
      "obj",
      "--target",
      target!.llvmTriple,
      "--opt-level",
      "2",
      "--relocation-model",
      "pic",
      "--diagnostic-format",
      "json",
      "--source-path",
      "/src/program.ts",
    ];
    const driver = spawn(process.execPath, ["-e", DRIVER, socket, dir, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    processes.push(driver);
    await new Promise<void>((resolve, reject) => {
      driver.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("sent")) resolve();
      });
      driver.once("exit", () => reject(new Error("the driver exited before sending")));
    });
    // The server is parsing and optimizing the module, which alone takes
    // tens of seconds, when the driver is killed as the kernel kills a build
    // that runs out of memory.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(server.exitCode).toBe(null);
    driver.kill("SIGKILL");
    await exitOf(driver);
    const killedAt = Date.now();
    const exited = await Promise.race([
      serverExit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    expect(exited).toBe(true);
    expect(Date.now() - killedAt).toBeLessThan(5000);
    // The next build finds no socket to a server that is gone.
    expect(existsSync(socket)).toBe(false);
  }, 60_000);
});
