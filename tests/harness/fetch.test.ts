import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";
// The servers live in the fixture tree (a plain .mjs): the Linux lane runs
// the IDENTICAL routes standalone inside its container.
// eslint-disable-next-line import/no-relative-packages
import { startFetchServers } from "../fixtures/fetch/servers.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/fetch");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/* ── the local servers (tests/fixtures/fetch/servers.mjs: all routes, the
 * refused port, and the counting forward proxy for the NODE_USE_ENV_PROXY
 * opt-in case) ───────────────────────────────────────────────────────── */

let servers: Awaited<ReturnType<typeof startFetchServers>>;
let baseUrl = "";
let refusedUrl = "";
let proxyUrl = "";
let secureProxyUrl = "";
let authenticatedProxyUrl = "";
let secureAuthenticatedProxyUrl = "";
const expectedProxyAuthorization = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;

beforeAll(async () => {
  servers = await startFetchServers();
  ({ baseUrl, refusedUrl, proxyUrl, secureProxyUrl } = servers);
  authenticatedProxyUrl = proxyUrl.replace("http://", "http://proxy-user:proxy-pass@");
  secureAuthenticatedProxyUrl = secureProxyUrl.replace(
    "https://",
    "https://proxy-user:proxy-pass@",
  );

  // Every child below inherits POISONED proxy env pointing at the refused
  // port: Node's fetch ignores http_proxy/https_proxy without the
  // NODE_USE_ENV_PROXY=1 opt-in, and the native runtime must match
  // — so every case in this file
  // doubles as the regression test for that parity, and any fixture that
  // DID consult the env would fail with a refused connection instead of leaving the machine.
  process.env["http_proxy"] = refusedUrl;
  process.env["https_proxy"] = refusedUrl;
  process.env["HTTP_PROXY"] = refusedUrl;
  process.env["HTTPS_PROXY"] = refusedUrl;
});

afterAll(async () => {
  delete process.env["http_proxy"];
  delete process.env["https_proxy"];
  delete process.env["HTTP_PROXY"];
  delete process.env["HTTPS_PROXY"];
  await servers.close();
});

/* ── build + run (the npm.test.ts pattern) ───────────────────────────── */

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runBinary(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout = 30_000,
): Promise<RunResult> {
  // Some JS entries rely on Node's module detection; that warning is not
  // program output.
  if (cmd === "node") {
    args = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", ...args];
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "buffer",
      env,
      timeout,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr))
      throw err;
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

// Keep sanitizer infrastructure noise separate from program stderr; the
// process warnings carry each process's own pid.
function expectCleanStderr(native: RunResult, node: RunResult): void {
  if (node.exitCode !== 0) return;
  const pid = (text: string): string => text.replace(/^\(node:\d+\) /gm, "(node:PID) ");
  const stderr = native.stderr
    .toString("utf8")
    .replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm, "");
  expect(pid(stderr)).toBe(pid(node.stderr.toString("utf8")));
}

async function build(entry: string, flavor = ""): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(fixturesRoot, "node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .update(flavor)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `fetch-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "fetch fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

const cases = globSync(join(fixturesRoot, "cases/*/main.ts"))
  .sort()
  .map((entry) => ({ name: entry.split("/").at(-2)!, entry }));

describe(`static fetch differential${sanitize ? " (sanitized)" : ""}`, () => {
  test.for(["llvm"] as const)("RequestInit wrapper spread / %s backend", async () => {
    const entry = join(fixturesRoot, "spread-wrapper/main.mts");
    const binary = await build(entry);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, baseUrl]),
      runBinary(binary, [baseUrl]),
    ]);
    expect(nativeRes.stdout).toEqual(nodeRes.stdout);
    expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
    expectCleanStderr(nativeRes, nodeRes);
  });

  const staticCases = [
    "static",
    "static-request",
    "static-coercion",
    "static-controller",
    "static-stream",
    "static-stream-this",
    "static-listener-this",
    "static-listener-noncallable",
    "static-abort-throw",
    "static-dispatch-throw",
    "static-response-json",
  ] as const;
  test.for(
    staticCases.flatMap((name) => (["llvm"] as const).map((backend) => [name, backend] as const)),
  )(
    "%s / %s backend",
    async ([name, backend]) => {
      const entry = join(
        fixturesRoot,
        `${name}/${
          name === "static-coercion" ||
          name === "static-stream-this" ||
          name.startsWith("static-listener-")
            ? "main.js"
            : "main.mts"
        }`,
      );
      const binary = await build(entry);
      const redirectKey = `${name}-${backend}`;
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl, `${redirectKey}-node`]),
        runBinary(binary, [baseUrl, `${redirectKey}-native`]),
      ]);
      expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "static fetch / %s backend settles an abandoned compressed response",
    async () => {
      const entry = join(fixturesRoot, "static-abandon/main.mts");
      const binary = await build(entry);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], undefined, 3_000),
        runBinary(binary, [baseUrl], undefined, 3_000),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "static fetch / %s backend trusts NODE_EXTRA_CA_CERTS",
    async () => {
      const certs = join(fixturesRoot, "../server/certs");
      const server = createHttpsServer(
        {
          key: readFileSync(join(certs, "localhost-key.pem")),
          cert: readFileSync(join(certs, "localhost.pem")),
        },
        (_request, response) => response.end("secure"),
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, () => {
          server.off("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing HTTPS address");
        const entry = join(fixturesRoot, "static-network/main.mts");
        const binary = await build(entry, "https-extra-ca");
        const argv = [`https://localhost:${address.port}`];
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(certs, "ca.pem"),
        };
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, ...argv], env),
          runBinary(binary, argv, env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    120_000,
  );

  test("native fetch snapshots proxy and extra-CA env before user code", async () => {
    const certs = join(fixturesRoot, "../server/certs");
    const server = createHttpsServer(
      {
        key: readFileSync(join(certs, "localhost-key.pem")),
        cert: readFileSync(join(certs, "localhost.pem")),
      },
      (_request, response) => response.end("secure"),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("missing HTTPS address");
      }
      const entry = join(fixturesRoot, "static-env-snapshot/main.mts");
      const binary = await build(entry, "env-snapshot");
      const argv = [
        `${baseUrl}/text`,
        proxyUrl,
        `https://localhost:${address.port}`,
        join(certs, "ca.pem"),
      ];
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of [
        "NODE_USE_ENV_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "no_proxy",
        "NO_PROXY",
      ]) {
        delete env[key];
      }
      const before = servers.proxiedRequests();
      const [nodeRes, ...nativeResults] = await Promise.all([
        runBinary("node", [entry, ...argv], env),
        runBinary(binary, argv, env),
      ]);
      for (const nativeRes of nativeResults) {
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
      }
      expect(servers.proxiedRequests() - before).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 120_000);

  test.for(["llvm"] as const)(
    "static fetch / %s backend supports IPv6 URL literals and NO_PROXY",
    async () => {
      const server = createHttpServer((_request, response) => response.end("ipv6"));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing HTTP address");
        const entry = join(fixturesRoot, "static-network/main.mts");
        const binary = await build(entry, "ipv6");
        const argv = [`http://[::1]:${address.port}`];
        const env = {
          ...process.env,
          NODE_USE_ENV_PROXY: "1",
          http_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          no_proxy: "[::1]",
          NO_PROXY: "[::1]",
        };
        const before = servers.proxiedRequests();
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, ...argv], env),
          runBinary(binary, argv, env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
        expect(servers.proxiedRequests() - before).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    120_000,
  );

  test("native fetch blocks bad ports on initial and redirect hops", async () => {
    let blockedRequests = 0;
    let redirectRequests = 0;
    let blockedServer: ReturnType<typeof createHttpServer> | undefined;
    let redirectServer: ReturnType<typeof createHttpServer> | undefined;
    try {
      for (const port of [6000, 6667, 10080, 6697, 4045]) {
        const candidate = createHttpServer((_request, response) => {
          blockedRequests++;
          response.end("bad-port server reached");
        });
        try {
          await new Promise<void>((resolve, reject) => {
            candidate.once("error", reject);
            candidate.listen(port, "127.0.0.1", () => {
              candidate.removeAllListeners("error");
              resolve();
            });
          });
          blockedServer = candidate;
          break;
        } catch (error) {
          candidate.removeAllListeners();
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
            throw error;
          }
        }
      }
      if (!blockedServer) {
        throw new Error("no Fetch-blocked fixture port was available");
      }
      const blockedAddress = blockedServer.address();
      if (blockedAddress === null || typeof blockedAddress === "string") {
        throw new Error("missing blocked-port address");
      }
      const blockedUrl = `http://127.0.0.1:${blockedAddress.port}`;

      redirectServer = createHttpServer((_request, response) => {
        redirectRequests++;
        response.writeHead(302, {
          connection: "close",
          location: blockedUrl,
        });
        response.end();
      });
      await new Promise<void>((resolve, reject) => {
        redirectServer!.once("error", reject);
        redirectServer!.listen(0, "127.0.0.1", () => {
          redirectServer!.removeAllListeners("error");
          resolve();
        });
      });
      const redirectAddress = redirectServer.address();
      if (redirectAddress === null || typeof redirectAddress === "string") {
        throw new Error("missing redirect address");
      }
      const redirectUrl = `http://127.0.0.1:${redirectAddress.port}/to-blocked-port`;

      const entry = join(fixturesRoot, "static-bad-port/main.mts");
      const binary = await build(entry, "bad-port");
      const argv = [blockedUrl, redirectUrl];
      const [nodeRes, ...nativeResults] = await Promise.all([
        runBinary("node", [entry, ...argv]),
        runBinary(binary, argv),
      ]);
      for (const nativeRes of nativeResults) {
        expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
      }
      expect(redirectRequests).toBe(2);
      expect(blockedRequests).toBe(0);
    } finally {
      await Promise.all(
        [redirectServer, blockedServer]
          .filter((server) => server?.listening)
          .map(
            (server) =>
              new Promise<void>((resolve, reject) => {
                server!.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
    }
  }, 120_000);
});

describe(`proxy env opt-in (NODE_USE_ENV_PROXY${sanitize ? ", sanitized" : ""})`, () => {
  // The other half of the proxy parity: WITH NODE_USE_ENV_PROXY=1 both
  // lanes honor http_proxy and route through the local forward proxy —
  // outputs stay byte-identical AND the proxy sees exactly one relayed
  // request per lane.
  test("both lanes authenticate to http_proxy when opted in", async () => {
    const entry = join(fixturesRoot, "cases/proxy-optin/main.ts");
    const binary = await build(entry);
    const argv = [baseUrl, refusedUrl];
    const env = {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      http_proxy: authenticatedProxyUrl,
      HTTP_PROXY: authenticatedProxyUrl,
      no_proxy: "",
      NO_PROXY: "",
    };
    const before = servers.proxiedRequests();
    const tunneledBefore = servers.tunneledRequests();
    const authBefore = servers.proxyAuthorizations().length;
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, ...argv], env),
      runBinary(binary, argv, env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
    expectCleanStderr(nativeRes, nodeRes);
    expect(servers.proxiedRequests() - before).toBe(2);
    // Both lanes reach the http:// target through a CONNECT tunnel.
    expect(servers.tunneledRequests() - tunneledBefore).toBe(2);
    expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
      expectedProxyAuthorization,
      expectedProxyAuthorization,
    ]);
  }, 120_000);

  test.for(["llvm"] as const)(
    "static fetch / %s backend authenticates to http_proxy",
    async () => {
      const entry = join(fixturesRoot, "static-proxy/main.mts");
      const binary = await build(entry, "proxy-optin");
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: authenticatedProxyUrl,
        HTTP_PROXY: authenticatedProxyUrl,
        no_proxy: "",
        NO_PROXY: "",
      };
      const before = servers.proxiedRequests();
      const authBefore = servers.proxyAuthorizations().length;
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], env),
        runBinary(binary, [baseUrl], env),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
      expect(servers.proxiedRequests() - before).toBe(2);
      expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
        expectedProxyAuthorization,
        expectedProxyAuthorization,
      ]);
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch authenticates over an HTTPS proxy transport",
    async () => {
      const entry = join(fixturesRoot, "static-proxy/main.mts");
      const binary = await build(entry, "proxy-https");
      const env = {
        ...process.env,
        NODE_EXTRA_CA_CERTS: join(fixturesRoot, "../server/certs/ca.pem"),
        NODE_USE_ENV_PROXY: "1",
        http_proxy: secureAuthenticatedProxyUrl,
        HTTP_PROXY: secureAuthenticatedProxyUrl,
        no_proxy: "",
        NO_PROXY: "",
      };
      const before = servers.proxiedRequests();
      const tunneledBefore = servers.tunneledRequests();
      const authBefore = servers.proxyAuthorizations().length;
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], env),
        runBinary(binary, [baseUrl], env),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
      expect(servers.proxiedRequests() - before).toBe(2);
      expect(servers.tunneledRequests() - tunneledBefore).toBe(2);
      expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
        expectedProxyAuthorization,
        expectedProxyAuthorization,
      ]);
    },
    120_000,
  );

  test("native fetch rejects an opted-in HTTPS proxy instead of dialing directly", async () => {
    const certs = join(fixturesRoot, "../server/certs");
    let directRequests = 0;
    const server = createHttpsServer(
      {
        key: readFileSync(join(certs, "localhost-key.pem")),
        cert: readFileSync(join(certs, "localhost.pem")),
      },
      (_request, response) => {
        directRequests++;
        response.end("secure");
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("missing HTTPS address");
      }
      const entry = join(fixturesRoot, "static-network-error/main.mts");
      const binary = await build(entry, "https-proxy-reject");
      const argv = [`https://localhost:${address.port}`];
      const env = {
        ...process.env,
        NODE_EXTRA_CA_CERTS: join(certs, "ca.pem"),
        NODE_USE_ENV_PROXY: "1",
        https_proxy: refusedUrl,
        HTTPS_PROXY: refusedUrl,
        no_proxy: "",
        NO_PROXY: "",
      };
      const [nodeRes, ...nativeResults] = await Promise.all([
        runBinary("node", [entry, ...argv], env),
        runBinary(binary, argv, env),
      ]);
      for (const nativeRes of nativeResults) {
        expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
      }
      expect(directRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 120_000);

  /** An HTTPS target on localhost that counts the requests it serves,
   * with the localhost certificate or another fixture certificate. */
  async function secureTarget(cert = "localhost"): Promise<{
    url: string;
    requests: () => number;
    close: () => Promise<void>;
  }> {
    const certs = join(fixturesRoot, "../server/certs");
    let requests = 0;
    const server = createHttpsServer(
      {
        key: readFileSync(join(certs, `${cert}-key.pem`)),
        cert: readFileSync(join(certs, `${cert}.pem`)),
      },
      (request, response) => {
        requests++;
        response.end(`secure ${request.url} ${request.headers.host}`);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `https://localhost:${port}`,
      requests: () => requests,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  test.for(["llvm"] as const)(
    "%s fetch tunnels HTTPS through an http_proxy with CONNECT",
    async () => {
      const target = await secureTarget();
      try {
        const entry = join(fixturesRoot, "static-proxy/main.mts");
        const binary = await build(entry, "proxy-connect");
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(fixturesRoot, "../server/certs/ca.pem"),
          NODE_USE_ENV_PROXY: "1",
          https_proxy: authenticatedProxyUrl,
          HTTPS_PROXY: authenticatedProxyUrl,
          no_proxy: "",
          NO_PROXY: "",
        };
        const before = servers.proxiedRequests();
        const authBefore = servers.proxyAuthorizations().length;
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, target.url], env),
          runBinary(binary, [target.url], env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.stdout.toString("utf8")).toContain("200 secure /text localhost:");
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
        expect(servers.proxiedRequests() - before).toBe(2);
        expect(target.requests()).toBe(2);
        expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
          expectedProxyAuthorization,
          expectedProxyAuthorization,
        ]);
      } finally {
        await target.close();
      }
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch verifies the target host through the CONNECT tunnel",
    async () => {
      // The alt certificate names alt.localhost only.
      const target = await secureTarget("alt");
      try {
        const entry = join(fixturesRoot, "static-network-error/main.mts");
        const binary = await build(entry, "proxy-connect-verify");
        const url = target.url;
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(fixturesRoot, "../server/certs/ca.pem"),
          NODE_USE_ENV_PROXY: "1",
          https_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          no_proxy: "",
          NO_PROXY: "",
        };
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, url], env),
          runBinary(binary, [url], env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.stdout.toString("utf8")).toBe("TypeError fetch failed true\n");
        expect(target.requests()).toBe(0);
      } finally {
        await target.close();
      }
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch sends proxy credentials only with a username and a password",
    async () => {
      const entry = join(fixturesRoot, "static-proxy/main.mts");
      const binary = await build(entry, "proxy-user-only");
      const userOnly = proxyUrl.replace("http://", "http://proxy-user@");
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: userOnly,
        HTTP_PROXY: userOnly,
        no_proxy: "",
        NO_PROXY: "",
      };
      const authBefore = servers.proxyAuthorizations().length;
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], env),
        runBinary(binary, [baseUrl], env),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expect(servers.proxyAuthorizations().slice(authBefore)).toEqual(["", ""]);
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch failures through a proxy carry Node's cause",
    async () => {
      // Answers every CONNECT with one fixed status line.
      const statusProxy = createNetServer((socket) => {
        socket.once("data", () => {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => statusProxy.listen(0, "127.0.0.1", resolve));
      const statusProxyUrl = `http://127.0.0.1:${(statusProxy.address() as AddressInfo).port}`;
      try {
        const entry = join(fixturesRoot, "static-proxy-error/main.mts");
        const binary = await build(entry, "proxy-error-cause");
        for (const proxy of [statusProxyUrl, refusedUrl]) {
          const env = {
            ...process.env,
            NODE_USE_ENV_PROXY: "1",
            https_proxy: proxy,
            HTTPS_PROXY: proxy,
            no_proxy: "",
            NO_PROXY: "",
          };
          const [nodeRes, nativeRes] = await Promise.all([
            runBinary("node", [entry, "https://localhost/"], env),
            runBinary(binary, ["https://localhost/"], env),
          ]);
          expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
          expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        }
      } finally {
        await new Promise<void>((resolve) => statusProxy.close(() => resolve()));
      }
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch tunnels HTTPS through an HTTPS proxy with CONNECT",
    async () => {
      const target = await secureTarget();
      try {
        const entry = join(fixturesRoot, "static-proxy/main.mts");
        const binary = await build(entry, "proxy-https-https");
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(fixturesRoot, "../server/certs/ca.pem"),
          NODE_USE_ENV_PROXY: "1",
          https_proxy: secureAuthenticatedProxyUrl,
          HTTPS_PROXY: secureAuthenticatedProxyUrl,
          no_proxy: "",
          NO_PROXY: "",
        };
        const before = servers.proxiedRequests();
        const tunneledBefore = servers.tunneledRequests();
        const authBefore = servers.proxyAuthorizations().length;
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, target.url], env),
          runBinary(binary, [target.url], env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.stdout.toString("utf8")).toContain("200 secure /text localhost:");
        expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
        expectCleanStderr(nativeRes, nodeRes);
        expect(servers.proxiedRequests() - before).toBe(2);
        expect(servers.tunneledRequests() - tunneledBefore).toBe(2);
        expect(target.requests()).toBe(2);
        expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
          expectedProxyAuthorization,
          expectedProxyAuthorization,
        ]);
      } finally {
        await target.close();
      }
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch verifies the target host through an HTTPS proxy tunnel",
    async () => {
      // The alt certificate names alt.localhost only.
      const target = await secureTarget("alt");
      try {
        const entry = join(fixturesRoot, "static-network-error/main.mts");
        const binary = await build(entry, "proxy-https-verify");
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(fixturesRoot, "../server/certs/ca.pem"),
          NODE_USE_ENV_PROXY: "1",
          https_proxy: secureProxyUrl,
          HTTPS_PROXY: secureProxyUrl,
          no_proxy: "",
          NO_PROXY: "",
        };
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, target.url], env),
          runBinary(binary, [target.url], env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect(nativeRes.stdout.toString("utf8")).toBe("TypeError fetch failed true\n");
        expect(target.requests()).toBe(0);
      } finally {
        await target.close();
      }
    },
    120_000,
  );

  test.for(["llvm"] as const)(
    "%s fetch rejects an invalid opted-in proxy instead of dialing directly",
    async () => {
      const entry = join(fixturesRoot, "static-proxy/main.mts");
      const binary = await build(entry, "proxy-invalid");
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: "not a valid proxy URL",
        HTTP_PROXY: "not a valid proxy URL",
        no_proxy: "",
        NO_PROXY: "",
      };
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], env),
        runBinary(binary, [baseUrl], env),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
      expect(nativeRes.exitCode).not.toBe(0);
    },
    120_000,
  );

  test("fetch honors wildcard no_proxy exclusions", async () => {
    const entry = join(fixturesRoot, "cases/proxy-optin/main.ts");
    const binary = await build(entry);
    const argv = ["http://sub.example.invalid", refusedUrl];
    const env = {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      http_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      no_proxy: "*.example.invalid",
      NO_PROXY: "*.example.invalid",
    };
    const before = servers.proxiedRequests();
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, ...argv], env),
      runBinary(binary, argv, env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
    expectCleanStderr(nativeRes, nodeRes);
    expect(servers.proxiedRequests() - before).toBe(0);
  }, 120_000);

  test.for(["llvm"] as const)(
    "static fetch / %s backend honors wildcard no_proxy exclusions",
    async () => {
      const entry = join(fixturesRoot, "static-network/main.mts");
      const binary = await build(entry, "proxy-wildcard");
      const argv = ["http://sub.example.invalid/path"];
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        no_proxy: "*.example.invalid",
        NO_PROXY: "*.example.invalid",
      };
      const before = servers.proxiedRequests();
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, ...argv], env),
        runBinary(binary, argv, env),
      ]);
      expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
      expect(servers.proxiedRequests() - before).toBe(0);
    },
    120_000,
  );
});

describe(`fetch differential (${cases.length} programs${sanitize ? ", sanitized" : ""})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))(
    "%s",
    async ([, c]) => {
      const binary = await build(c.entry);
      const argv = [baseUrl, refusedUrl];
      const nodeArgv =
        c.name === "redirect-resolution" ? [...argv, "redirect-resolution-node"] : argv;
      const nativeArgv =
        c.name === "redirect-resolution" ? [...argv, "redirect-resolution-native"] : argv;
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [c.entry, ...nodeArgv]),
        runBinary(binary, nativeArgv),
      ]);
      if (!nodeRes.stdout.equals(nativeRes.stdout)) {
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect.unreachable("stdout differed at byte level but not after utf8 decode");
      }
      expect(nativeRes.exitCode, nativeRes.stderr.toString("utf8")).toBe(nodeRes.exitCode);
      expectCleanStderr(nativeRes, nodeRes);
    },
    120_000,
  );
});

test("custom RequestInit dispatchers are refused without the engine", () => {
  const entry = join(fixturesRoot, "vercel-env-proxy/main.mts");
  expect(analyze(entry).coverage.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "SC2020",
      message: expect.stringContaining("RequestInit option 'dispatcher'"),
    }),
  );
});
