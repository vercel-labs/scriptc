// A runtime function name on a body that takes the TestContext is refused
// by name: the name is read through the function's dynamic view, which such
// a body has none of.
import { test, type TestContext } from "node:test";

declare const body: (t: TestContext) => void;

test(body);
