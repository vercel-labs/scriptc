import { expect, test } from "vitest";
import { moduleTagNumber, portableRelativePath } from "./stable-names.js";

test("module tag numbers depend only on the file name and stay distinct", () => {
  const first = moduleTagNumber("lib/a.ts", new Set());
  expect(moduleTagNumber("lib/a.ts", new Set([7, 8]))).toBe(first);
  expect(moduleTagNumber("lib/b.ts", new Set())).not.toBe(first);
  expect(moduleTagNumber("lib/a.ts", new Set([first]))).toBe((first + 1) >>> 0);
  expect(moduleTagNumber("lib/a.ts", new Set([first, (first + 1) >>> 0]))).toBe((first + 2) >>> 0);
});

test("relative module paths use / on every platform", () => {
  expect(portableRelativePath("/repo/src", "/repo/src/lib/a.ts", "linux")).toBe("lib/a.ts");
  expect(portableRelativePath("C:/repo/src", "C:/repo/src/lib/a.ts", "win32")).toBe("lib/a.ts");
  expect(portableRelativePath("C:\\repo\\src", "C:/repo/node_modules/x/index.d.ts", "win32")).toBe(
    "../node_modules/x/index.d.ts",
  );
  expect(
    moduleTagNumber(portableRelativePath("C:/repo", "C:/repo/lib/a.ts", "win32"), new Set()),
  ).toBe(moduleTagNumber(portableRelativePath("/repo", "/repo/lib/a.ts", "linux"), new Set()));
});
