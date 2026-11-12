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
    label?: string;
    static?: { evidence?: string; status?: string; tests?: string[] };
  }>;
};

describe("Node compatibility generator", () => {
  test("does not attribute bare fs APIs to fs/promises lowering", () => {
    const bareFsRows = snapshot.rows.filter(
      (row) => row.chapter === "fs" && row.apiSymbol.startsWith("fs."),
    );

    expect(bareFsRows.length).toBeGreaterThan(0);
    expect(bareFsRows.every((row) => !row.static?.evidence?.includes("fs.promises"))).toBe(true);
  });

  test("keeps fsPromises APIs attributed to fs/promises lowering", () => {
    const promiseRows = snapshot.rows.filter(
      (row) => row.chapter === "fs" && row.apiSymbol.startsWith("fsPromises."),
    );

    expect(promiseRows.length).toBeGreaterThan(0);
    // The surface manifest attributes the fs/promises rows it documents; a
    // dedicated compiler feature (fs.fsPromises.<name>) attributes the rows
    // it does not cover. Either names the fs/promises lowering.
    expect(
      promiseRows.some((row) => {
        const evidence = row.static?.evidence ?? "";
        return (
          evidence.includes("node-builtin.fs.promises") ||
          evidence.includes("compiler-feature:fs.fsPromises.")
        );
      }),
    ).toBe(true);
  });

  test("island-served rows name their differential island evidence", () => {
    const islandRows = snapshot.rows.filter((row) => row.static?.status === "island-served");

    expect(islandRows.length).toBeGreaterThan(0);
    for (const row of islandRows) {
      expect(row.static?.tests?.length ?? 0).toBeGreaterThan(0);
      expect(row.static?.evidence).toMatch(/^compiler-(?:feature|dedicated):/);
    }
    // process.report is answered by the Node island; the native build keeps
    // the refusal, so it is never a native support claim.
    const reportRows = islandRows.filter(
      (row) => row.chapter === "process" && row.label === "report",
    );
    expect(reportRows).toHaveLength(1);
    expect(reportRows[0]?.static?.tests).toContain(
      "tests/corpus/8830-process-report-island/main.ts",
    );
  });
});
