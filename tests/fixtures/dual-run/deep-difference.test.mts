import { test } from "node:test";
import assert from "node:assert/strict";

// The lanes differ at the last line of a multiline assertion message, past
// the short diff's context. The report's heading must name this test above
// the diff.
test("deep difference", () => {
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) lines.push(`row ${i}`);
  lines.push(process.execPath);
  const expected = [...lines.slice(0, 8), "/expected/node"].join("\n");
  assert.equal(lines.join("\n"), expected);
});
