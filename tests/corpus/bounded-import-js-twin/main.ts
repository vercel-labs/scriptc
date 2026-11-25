// A constant specifier names the file Node loads at run time, even beside a
// TypeScript twin of the same stem: "./twin.js" is twin.js, not twin.ts.
import { kind as tsKind } from "./twin.ts";

interface K {
  kind: string;
}

async function main(): Promise<void> {
  const folded = (await import("./twin" + ".js")) as unknown as K;
  console.log("static", tsKind, "folded", folded.kind);
}

void main();
