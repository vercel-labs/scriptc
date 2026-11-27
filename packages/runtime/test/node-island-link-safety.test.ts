// A module tree shipped beside the executable may be writable by someone
// other than the user running the program, so a manifest-listed link there may
// have been replaced. The Windows verifier must read such a link as a link:
// opening it as a path opens whatever it names, and a link naming another
// computer (`\\server\share`, `\??\UNC\server\share`) would offer the
// account's credentials over SMB before the tree could be rejected. These
// reads pin that shape of the code — the link is opened with
// FILE_FLAG_OPEN_REPARSE_POINT, its target is read with FSCTL_GET_REPARSE_POINT,
// a remote target is refused by its text, and the verifier itself opens
// nothing — so a rewrite cannot quietly reintroduce the open.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const source = readFileSync(join(import.meta.dirname, "../src/scr_node_island.c"), "utf8");

/** The body of the function named `name`, by brace matching. */
function body(name: string): string {
  // The definition, not the prototype above it: the opening brace is on the
  // line that closes the parameter list.
  const at = source.search(new RegExp(`^static [^\\n]*\\b${name}\\([^\\n]*\\)\\s*\\{`, "m"));
  if (at < 0) throw new Error(`scr_node_island.c has no definition of ${name}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${name} has no matching brace`);
}

describe("the Windows module-link verifier", () => {
  test("opens a link as a link, never as the path it names", () => {
    const read = body("ni_win_link_target");
    expect(read).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(read).toContain("FSCTL_GET_REPARSE_POINT");
    // The record is read for its names, not followed.
    expect(read).not.toContain("GetFinalPathNameByHandleW");
  });

  test("reads the substitute name, the target the system follows, not the print name", () => {
    const read = body("ni_win_link_target");
    // fields[0]/fields[1] are the substitute name's offset and length;
    // fields[2]/fields[3] are the print name, which is display only and can
    // name a different path than the one the link follows.
    expect(read).toMatch(/offset = fields\[0\], chars = fields\[1\]/);
    expect(read).not.toContain("fields[2]");
    expect(read).not.toContain("fields[3]");
  });

  test("the verifier itself opens nothing before it compares", () => {
    const verify = body("ni_dir_link_matches");
    expect(verify).not.toContain("CreateFileW");
    expect(verify).not.toContain("GetFileAttributesW");
    expect(verify).not.toContain("GetFinalPathNameByHandleW");
    // It reads the stored target and resolves it as text.
    expect(verify).toContain("ni_win_link_target(");
    expect(verify).toContain("ni_win_link_absolute(");
  });

  test("a target naming another computer is refused by its text, before resolution", () => {
    const remote = body("ni_win_remote_target");
    // UNC (`\\server\share`) and the device form a reparse point stores it in.
    expect(remote).toContain('L"\\\\??\\\\"');
    expect(remote).toContain('L"UNC\\\\"');
    expect(remote).toContain("plain[0] == L'\\\\' && plain[1] == L'\\\\'");

    const absolute = body("ni_win_link_absolute");
    const refuses = absolute.indexOf("ni_win_remote_target(");
    const resolves = absolute.indexOf("GetFullPathNameW(");
    expect(refuses).toBeGreaterThanOrEqual(0);
    expect(resolves).toBeGreaterThan(refuses);
  });

  test("POSIX keeps reading the link itself", () => {
    // The POSIX verifier is the sibling definition of the same function; it
    // reads the link target and opens no path either.
    const readings = [
      ...source.matchAll(/static bool ni_dir_link_matches\([^)]*\) \{[^}]*\}/g),
    ].map((m) => m[0]);
    expect(readings).toHaveLength(2);
    expect(readings.some((text) => text.includes("readlinkat("))).toBe(true);
  });
});
