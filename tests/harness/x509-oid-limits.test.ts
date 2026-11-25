/* A certificate's OID arcs render only within a bounded budget. Decimal
 * conversion of a subidentifier costs time quadratic in its length, so a
 * certificate can carry an arc wide enough to stall a program that inspects
 * it. An arc past the budget is omitted from the field that carries it
 * instead: `keyUsage` and the legacy `ext_key_usage` skip that purpose,
 * which fails closed for a purpose check. Node prints the whole arc; this
 * bounds the work on input a certificate supplier controls.
 *
 * The program reads three certificates: one whose extended key usage holds
 * an arc exactly at the budget beside serverAuth, one a byte past it, and
 * one with a 64 KiB arc. Only the first renders both purposes. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

// A parseable certificate whose extended key usage this test replaces. Its
// signature is not checked on construction.
const TEMPLATE = `-----BEGIN CERTIFICATE-----
MIIBYjCCAQigAwIBAgIUQzfK18SDdjhuZqmMiwAOryg+bC0wCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHYW55LWVrdTAeFw0yNjExMTEyMDU4MzlaFw0zNjExMDgyMDU4
MzlaMBIxEDAOBgNVBAMMB2FueS1la3UwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAR6PwfhBEAigHOMP3j6cBpvJe3JdixngVOYlVAipAJpczK6ecJ2GSZZGYYmuRj3
d65PgndiHhWY5uPYxPk8LP2iozwwOjAZBgNVHSUEEjAQBgRVHSUABggrBgEFBQcD
ATAdBgNVHQ4EFgQU+M3z20qHdLql+qteGyEXnG7rMXAwCgYIKoZIzj0EAwIDSAAw
RQIhAKRThDuSBRRK5+qEWgRhlD9l1MXwuv95U9JcsDQZCXolAiAK8syN+YHf37Go
WjGuS9ktkVKGL4qeOen3OOypRAVmEw==
-----END CERTIFICATE-----`;

interface Tlv {
  tag: number;
  content: Buffer;
  children: Tlv[] | null;
}

function readLength(b: Buffer, at: number, end: number): [number, number] {
  const first = b[at]!;
  if (first < 0x80) return [first, at + 1];
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new Error("unsupported DER length");
  let length = 0;
  for (let i = 0; i < count; i++) {
    if (at + 1 + i >= end) throw new Error("truncated DER length");
    length = length * 256 + b[at + 1 + i]!;
  }
  return [length, at + 1 + count];
}

function parseTlv(b: Buffer, start: number, end: number): Tlv[] {
  const nodes: Tlv[] = [];
  for (let at = start; at < end;) {
    const tag = b[at]!;
    const [length, contentStart] = readLength(b, at + 1, end);
    const contentEnd = contentStart + length;
    const node: Tlv = { tag, content: b.subarray(contentStart, contentEnd), children: null };
    if (tag & 0x20) node.children = parseTlv(b, contentStart, contentEnd);
    nodes.push(node);
    at = contentEnd;
  }
  return nodes;
}

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeTlv(nodes: Tlv[]): Buffer {
  const parts: Buffer[] = [];
  for (const node of nodes) {
    const content = node.children ? encodeTlv(node.children) : node.content;
    parts.push(Buffer.from([node.tag]), derLength(content.length), content);
  }
  return Buffer.concat(parts);
}

/** A base-128 subidentifier. */
function subidentifier(value: bigint): number[] {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(Number(v & 0x7fn));
    v >>= 7n;
  } while (v > 0n);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

/** The dotted OID 1.3.6.1.5.5.7.3.<arc> as DER content. */
function ekuOid(arc: bigint): Buffer {
  return Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, ...subidentifier(arc)]);
}

/** The template certificate with its extended key usage replaced. */
function certificateWithEku(purposes: Buffer[]): string {
  const der = Buffer.from(TEMPLATE.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const tree = parseTlv(der, 0, der.length);
  const findExtnValue = (nodes: Tlv[]): Tlv | null => {
    for (const node of nodes) {
      const children = node.children;
      if (!children) continue;
      for (let i = 0; i + 1 < children.length; i++) {
        const oid = children[i]!;
        if (oid.tag === 0x06 && oid.content.equals(Buffer.from([0x55, 0x1d, 0x25])))
          return children[i + 1]!;
      }
      const found = findExtnValue(children);
      if (found) return found;
    }
    return null;
  };
  const extnValue = findExtnValue(tree);
  if (!extnValue) throw new Error("template has no extended key usage");
  const inner = parseTlv(extnValue.content, 0, extnValue.content.length);
  const sequence = inner[0];
  if (!sequence) throw new Error("empty extension");
  sequence.children = purposes.map((content) => ({ tag: 0x06, content, children: null }));
  extnValue.content = encodeTlv(inner);
  extnValue.children = null;
  const pem =
    encodeTlv(tree)
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`;
}

const SERVER_AUTH = ekuOid(1n);
const AT_BUDGET = (1n << 223n) + 12345n;
const OVER_BUDGET = (1n << 225n) + 7n;
const HUGE = 1n << (7n * 65535n);

test("an oversized OID arc is omitted instead of converted", async () => {
  const certificates = [
    certificateWithEku([SERVER_AUTH, ekuOid(AT_BUDGET)]),
    certificateWithEku([SERVER_AUTH, ekuOid(OVER_BUDGET)]),
    certificateWithEku([SERVER_AUTH, ekuOid(HUGE)]),
  ];
  const dir = mkdtempSync(join(tmpdir(), "scriptc-x509-oid-limits-"));
  try {
    const entry = join(dir, "main.ts");
    const binary = join(dir, "main");
    writeFileSync(
      entry,
      [
        `import * as crypto from "node:crypto";`,
        `const certificates: string[] = ${JSON.stringify(certificates)};`,
        `for (const pem of certificates) {`,
        `  const cert = new crypto.X509Certificate(pem);`,
        `  const usage: string[] | undefined = cert.keyUsage;`,
        `  console.log(usage === undefined ? "absent" : usage.join(" "));`,
        `  const legacy = cert.toLegacyObject().ext_key_usage;`,
        `  console.log(legacy === undefined ? "absent" : legacy.join(" "));`,
        `}`,
        ``,
      ].join("\n"),
    );
    await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
      env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    const both = `1.3.6.1.5.5.7.3.1 1.3.6.1.5.5.7.3.${AT_BUDGET}`;
    const standard = "1.3.6.1.5.5.7.3.1";
    const expected = [both, both, standard, standard, standard, standard].join("\n") + "\n";
    const started = performance.now();
    const run = await execFileAsync(binary, [], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20_000,
    });
    const elapsed = performance.now() - started;
    expect(run.stdout).toBe(expected);
    // A 64 KiB arc took seconds to convert; an omitted one costs a scan.
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
