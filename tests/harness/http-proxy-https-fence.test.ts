/* The module's environment proxy covers a plain-http target end to end, but an
 * https target needs a CONNECT tunnel this runtime does not model yet: the
 * request refuses instead of going around the proxy the program asked for. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-https-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  name: string,
  source: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return { code: -1, stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const failure = e as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("an https request under the environment proxy refuses instead of bypassing it", async () => {
  const { code, stderr } = await run(
    "https-fence",
    `import * as http from "node:http";
import * as https from "node:https";
http.setGlobalProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:1" });
https.get("https://target.invalid/x");
`,
  );
  expect(code).toBe(1);
  expect(stderr).toContain(
    "https requests through the environment proxy (CONNECT tunnelling) are not supported yet",
  );
  expect(stderr).toContain("SC2020");
});

test("NO_PROXY exempts an https target from the refusal", async () => {
  const { stderr } = await run(
    "https-no-proxy",
    `import * as http from "node:http";
import * as https from "node:https";
http.setGlobalProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "target.invalid" });
https.get("https://target.invalid/x").on("error", (e) => console.log("error", e.code));
`,
  );
  // the request proceeds to a direct dial (which fails to resolve: the point
  // is that the proxy fence did not fire)
  expect(stderr).not.toContain("CONNECT tunnelling");
});
