// A runtime function name combined with an options object is not lowered
// yet: the diagnostic names both the form and the way out.
import { test } from "node:test";

declare const body: () => void;

test({ timeout: 10 }, body);
