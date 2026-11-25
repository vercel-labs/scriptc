// @exit: 0
// A todo suite flagged { expectFailure } that completes without throwing
// reports todo, lists its failure, and leaves the process's status alone.
import { describe, test } from "node:test";

describe("todo suite", { todo: true, expectFailure: true }, () => {
  test("child passes", () => {});
});
