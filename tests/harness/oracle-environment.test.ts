import { expect, test } from "vitest";
import { oracleEnvironmentFingerprint } from "./oracle-environment.js";

test("oracle environment fingerprint changes with Node path and home inputs", () => {
  const base = oracleEnvironmentFingerprint({ HOME: "/home/one", PATH: "/bin", TMPDIR: "/tmp/one" });

  expect(oracleEnvironmentFingerprint({ HOME: "/home/one", PATH: "/bin", TMPDIR: "/tmp/two" })).not.toBe(base);
  expect(oracleEnvironmentFingerprint({ HOME: "/home/two", PATH: "/bin", TMPDIR: "/tmp/one" })).not.toBe(base);
  expect(oracleEnvironmentFingerprint({ HOME: "/home/one", PATH: "/sbin", TMPDIR: "/tmp/one" })).not.toBe(base);
});

test("oracle environment fingerprint distinguishes unset and empty variables", () => {
  expect(oracleEnvironmentFingerprint({ TMPDIR: undefined })).not.toBe(
    oracleEnvironmentFingerprint({ TMPDIR: "" }),
  );
});

test("oracle environment fingerprint ignores unrelated variables", () => {
  expect(oracleEnvironmentFingerprint({ TMPDIR: "/tmp", UNRELATED: "one" })).toBe(
    oracleEnvironmentFingerprint({ TMPDIR: "/tmp", UNRELATED: "two" }),
  );
});
