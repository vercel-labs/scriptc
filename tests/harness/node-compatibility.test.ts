import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const snapshot = JSON.parse(
  readFileSync(join(repoRoot, "internal/compatibility/generated/node-v24-internal.json"), "utf8"),
) as {
  rows: Array<{
    chapter: string;
    apiSymbol: string;
    static?: { evidence?: string };
  }>;
};

describe("Node compatibility generator", () => {
  test("does not attribute bare fs APIs to fs/promises lowering", () => {
    const bareFsRows = snapshot.rows.filter((row) => row.chapter === "fs" && row.apiSymbol.startsWith("fs."));

    expect(bareFsRows.length).toBeGreaterThan(0);
    expect(bareFsRows.every((row) => !row.static?.evidence?.includes("fs.promises"))).toBe(true);
  });

  test("keeps fsPromises APIs attributed to fs/promises lowering", () => {
    const promiseRows = snapshot.rows.filter((row) => row.chapter === "fs" && row.apiSymbol.startsWith("fsPromises."));

    expect(promiseRows.length).toBeGreaterThan(0);
    expect(promiseRows.some((row) => row.static?.evidence?.includes("node-builtin.fs.promises"))).toBe(true);
  });
});
