import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_url_legacy");
const vendorDir = join(testDir, "../vendor/quickjs-ng");

// Compiled once with ASan + the RC audit: the oracle run also proves the
// legacy url port neither leaks nor double-frees across the case file's
// calls, thrown errors included. Hostnames lowercase and normalize through
// the vendored libunicode, as in programs.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    // no -Wall/-Wextra: the vendored libunicode.c is not warning-clean
    "-std=c11",
    "-O1",
    "-fsanitize=address",
    "-DSCR_RC_AUDIT",
    "-I",
    vendorDir,
    "-o",
    bin,
    join(testDir, "test_url_legacy.c"),
    join(testDir, "../src/scr_url_legacy.c"),
    join(testDir, "../src/scr_idna.c"),
    join(testDir, "../src/scr_qs.c"),
    join(testDir, "../src/scr_regex.c"),
    // scr_regex.c hosts assert.match and calls the assert throw/inspect
    // helpers — regex-linking binaries always carry scr_assert.c.
    join(testDir, "../src/scr_assert.c"),
    join(vendorDir, "libregexp.c"),
    join(vendorDir, "libunicode.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_arena.c"),
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_hash.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
}, 120_000);

// Runs against the committed case file, generated from Node v24 itself
// (gen-url-legacy-cases.mjs): curated domains (IDNA mapping, Punycode,
// ContextJ and bidi rules, IPv4 and IPv6 hosts), legacy URLs (hosts,
// auth, ports, backslashes, whitespace, autoEscape, IPv6, IDNA hostnames,
// parsed queries), url.resolve over a base/relative grid, url.format over
// objects, and a seeded fuzz corpus of each.
test("node:url legacy API and domain conversion match Node on committed oracle cases", async () => {
  const { stderr } = await execFileAsync(bin, [join(testDir, "url-legacy-cases.txt")], {
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
}, 120_000);
