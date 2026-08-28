/* Portless end-to-end: compile the real external checkout and run its proxy
 * and alias workflows without Node at runtime. This follows the optional
 * external-suite convention used by prettier-e2e and vercel-e2e: the suite
 * skips when the checkout is absent and SCRIPTC_PORTLESS_ROOT overrides the
 * default location.
 *
 * SETUP:
 *   git clone https://github.com/vercel-labs/portless.git ~/Developer/portless-scratch
 *   git -C ~/Developer/portless-scratch checkout d42c741ac67d20a0b6e1f8f5b4192136de34fa03
 *   pnpm -C ~/Developer/portless-scratch install --frozen-lockfile
 *
 * Portless owns any build-time version stamping. Scriptc deliberately does
 * not provide bundler-style constant substitution. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const portlessRoot = process.env["SCRIPTC_PORTLESS_ROOT"] ?? join(homedir(), "Developer/portless-scratch");
const portlessPackage = join(portlessRoot, "packages/portless");
const sourceEntry = join(portlessPackage, "src/cli.ts");
const suite = existsSync(sourceEntry) ? describe : describe.skip;
const cleanup: Array<() => void | Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "ASAN_OPTIONS", "LSAN_OPTIONS", "UBSAN_OPTIONS", "DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.kill("SIGTERM");
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no TCP address"));
      server.close(() => resolve(address.port));
    });
  });
}

function get(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function waitForProxy(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await get(port, "missing.localhost");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("native Portless proxy did not start");
}

suite("Portless acceptance", () => {
  test("builds and proxies a live alias without Node at runtime", async () => {
    const work = await mkdtemp(join(tmpdir(), "scriptc-portless-"));
    cleanup.push(() => rm(work, { recursive: true, force: true }));
    const pkg = JSON.parse(readFileSync(join(portlessRoot, "packages/portless/package.json"), "utf8")) as { version: string };
    const shadowPackage = join(work, "checkout");
    await cp(portlessPackage, shadowPackage, {
      recursive: true,
      filter: (source) => source !== join(portlessPackage, "node_modules"),
    });
    await symlink(join(portlessPackage, "node_modules"), join(shadowPackage, "node_modules"),
                  process.platform === "win32" ? "junction" : "dir");
    const entry = join(shadowPackage, "src/cli.ts");
    const source = readFileSync(entry, "utf8");
    const stamped = source.replace(
      /^(?:declare const __VERSION__: string;|const __VERSION__ = .*;)$/m,
      `const __VERSION__ = ${JSON.stringify(pkg.version)};`,
    );
    if (stamped === source && !source.includes(`const __VERSION__ = ${JSON.stringify(pkg.version)};`)) {
      throw new Error("Portless __VERSION__ declaration was not found");
    }
    writeFileSync(entry, stamped);
    const binary = join(work, "portless");
    const built = await compile(entry, {
      outDir: work,
      outPath: binary,
      backend: "c",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const proxyPort = await freePort();
    const backendPort = await freePort();
    const stateDir = join(work, "state");
    const env = childEnv({ PORTLESS_STATE_DIR: stateDir, PORTLESS_SYNC_HOSTS: "0" });
    const proxy = spawn(binary, ["proxy", "start", "--no-tls", "-p", String(proxyPort), "--foreground"], {
      cwd: portlessRoot,
      env,
      stdio: "ignore",
    });
    cleanup.push(() => terminate(proxy));
    await waitForProxy(proxyPort);

    const backend = createServer((_req, res) => res.end("native-portless-ok"));
    await new Promise<void>((resolve, reject) => {
      backend.once("error", reject);
      backend.listen(backendPort, "127.0.0.1", resolve);
    });
    cleanup.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));

    const alias = spawn(binary, ["alias", "app", String(backendPort), "-p", String(proxyPort)], {
      cwd: portlessRoot,
      env,
      stdio: "ignore",
    });
    const aliasCode = await new Promise<number | null>((resolve) => alias.once("close", resolve));
    expect(aliasCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(get(proxyPort, "app.localhost")).resolves.toEqual({ status: 200, body: "native-portless-ok" });
  }, 300_000);
});
