import { expect, test } from "vitest";
import { oracleEnvKey } from "./oracle-env.js";

test("the oracle key changes with any inherited variable", () => {
  const base = { PATH: "/bin", SCRIPTC_TEST_ENV: "from-harness" };
  expect(oracleEnvKey({ ...base, NODE_ENV: "production" })).not.toBe(
    oracleEnvKey({ ...base, NODE_ENV: "test" }),
  );
  expect(oracleEnvKey({ ...base, NODE_ENV: "test" })).not.toBe(oracleEnvKey(base));
  expect(oracleEnvKey({ ...base, FOO: "a=b" })).not.toBe(
    oracleEnvKey({ ...base, FOO: "a", B: "" }),
  );
});

test("the oracle key ignores the runner's worker numbers and variable order", () => {
  expect(oracleEnvKey({ A: "1", B: "2", VITEST_WORKER_ID: "1", VITEST_POOL_ID: "1" })).toBe(
    oracleEnvKey({
      VITEST_POOL_ID: "7",
      B: "2",
      TINYPOOL_WORKER_ID: "3",
      A: "1",
      VITEST_WORKER_ID: "9",
    }),
  );
});
