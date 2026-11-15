// A command-line tool whose modules build their tables when they load, and
// whose `--version` uses none of them: the time to exit is what the unused
// tables cost a start. `check` uses every table once.
import { root, SQUARES } from "./squares.ts";
import { hex, COLORS } from "./colors.ts";
import { factor, UNITS } from "./units.ts";
import { isVersion, PATTERNS } from "./patterns.ts";

function check(): string {
  return [
    root(SQUARES[1234]!),
    hex("c77"),
    COLORS.length,
    factor("u7_9"),
    UNITS.length,
    isVersion("1.20.3"),
    Object.keys(PATTERNS).length,
  ].join(" ");
}

const command = process.argv[2] ?? "--version";
if (command === "--version") console.log("1.4.0");
else if (command === "check") console.log(check());
else {
  console.error("unknown command: " + command);
  process.exitCode = 2;
}
