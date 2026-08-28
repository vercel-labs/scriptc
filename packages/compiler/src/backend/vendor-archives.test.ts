import { expect, test } from "vitest";
import { resolveCc } from "./native-toolchain.js";
import { driverUsesZig, usesVendoredZlib, vendorArArgv } from "./vendor-archives.js";

/** The vendored-prerequisite recipes and the zlib link once keyed their
 * toolchain choices on `driver.target === null` — "is this a host build?" —
 * which conflates the build being native with a POSIX toolchain and system
 * libraries being present. Those are independent: `SCRIPTC_CC=zigcc` with no
 * `SCRIPTC_TARGET` is a host build driven by zig, which supplies its own
 * archiver and needs the vendored zlib. These pin the driver-based dispatch. */

test("bare clang host driver keeps the historical system ar and -lz", () => {
  const driver = resolveCc({}, "linux");

  expect(driver.argv).toEqual(["clang"]);
  expect(driver.target).toBeNull();
  expect(driverUsesZig(driver)).toBe(false);
  expect(vendorArArgv(driver)).toEqual(["ar"]);
  expect(usesVendoredZlib(driver)).toBe(false);
});

test("host-native zigcc archives with zig ar, not a system ar", () => {
  const driver = resolveCc({ SCRIPTC_CC: "zigcc" }, "linux");

  // A host build (target === null) that is nonetheless driven by zig.
  expect(driver.argv).toEqual(["zig", "cc"]);
  expect(driver.target).toBeNull();
  expect(driverUsesZig(driver)).toBe(true);
  // Regression: keying on `target === null` yielded ["ar"] here, handing a
  // clang-built archive to a zig link — and failing outright on hosts with
  // no system ar at all.
  expect(vendorArArgv(driver)).toEqual(["zig", "ar"]);
});

test("host-native zigcc links the vendored zlib, not a system -lz", () => {
  const driver = resolveCc({ SCRIPTC_CC: "zigcc" }, "win32");

  expect(driver.target).toBeNull();
  // Regression: keying on `target === null` selected the system `-lz` (and
  // omitted the vendored zlib headers), which no zig host toolchain provides.
  expect(usesVendoredZlib(driver)).toBe(true);
});

test("cross builds keep using the zig toolchain and vendored zlib", () => {
  const driver = resolveCc(
    { SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: "x86_64-linux-gnu" },
    "linux",
  );

  expect(driver.target).toBe("x86_64-linux-gnu");
  expect(driverUsesZig(driver)).toBe(true);
  expect(vendorArArgv(driver)).toEqual(["zig", "ar"]);
  expect(usesVendoredZlib(driver)).toBe(true);
});

test("the archiver spelling tracks the driver argv rather than a literal", () => {
  // vendorArArgv must derive the zig spelling from argv[0], so a renamed or
  // absolute driver spelling still archives with its own `ar` subcommand.
  expect(vendorArArgv({ argv: ["zig", "cc"] })).toEqual(["zig", "ar"]);
  expect(vendorArArgv({ argv: ["clang"] })).toEqual(["ar"]);
});
