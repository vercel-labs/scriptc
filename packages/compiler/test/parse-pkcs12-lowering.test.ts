import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The statements of the lowered parsePKCS12 result-record helper. */
async function helperBody(source: string): Promise<Record<string, unknown>[]> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-pkcs12-lowering-"));
  try {
    const entry = join(directory, "main.ts");
    const outPath = join(directory, "program.ir");
    writeFileSync(entry, source);
    const result = await compile(entry, { outDir: directory, outPath, outputKind: "ir" });
    expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    const document = JSON.parse(readFileSync(outPath, "utf8")) as {
      functions: { name: string; body: Record<string, unknown>[] }[];
    };
    const helper = document.functions.find((fn) => fn.name.startsWith("%p12.record"));
    expect(helper).toBeDefined();
    return helper!.body;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const SOURCE = `import { parsePKCS12 } from "node:crypto";
const parsed = parsePKCS12(Buffer.from(""), { passphrase: "" });
console.log(parsed.additionalCertificates.length, parsed.certificate === null);
`;

// The loop's bundle lookup overwrites `der` on every iteration, but the
// declaration of `der` reads the loop index. It must run after the index is
// initialized, or the runtime receives an indeterminate double as the
// certificate position.
test("the certificate loop index is initialized before the first lookup", async () => {
  const body = await helperBody(SOURCE);
  const indexAssignment = body.findIndex(
    (statement) => statement["kind"] === "assign" && statement["localId"] === "index.0",
  );
  expect(indexAssignment).toBeGreaterThanOrEqual(0);
  expect(body[indexAssignment]!["value"]).toMatchObject({ kind: "numLit", value: 0 });
  const firstLookup = body.findIndex(
    (statement) =>
      statement["kind"] === "varDecl" &&
      (statement["init"] as { fn?: string } | undefined)?.fn === "crypto.pkcs12Der",
  );
  expect(firstLookup).toBeGreaterThan(indexAssignment);
});
