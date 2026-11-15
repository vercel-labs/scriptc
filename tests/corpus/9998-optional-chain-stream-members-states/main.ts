// The reads of 9997 under @types/node (this program has a tsconfig), in a
// child whose standard streams the parent chooses: the null device, pipes,
// the parent's own. tty.ReadStream and tty.WriteStream declare isTTY, columns
// and rows without `undefined`; a stream has none of them off a terminal,
// and the optional-chain read answers undefined there as the plain read does.
// The child reports on its stderr, which is a pipe in every state.
import { spawnSync } from "node:child_process";

function text(value: boolean | number | undefined): string {
  return value === undefined ? "absent" : typeof value + " " + String(value);
}

function wants(value: boolean): string {
  return typeof value + ":" + String(value);
}

function describe(out: NodeJS.WriteStream): string {
  return [
    text(out?.isTTY),
    text(out.isTTY),
    text(out?.columns),
    text(out?.rows ?? 24),
    String(!!out?.isTTY),
    wants(out?.isTTY),
  ].join(", ");
}

function report(label: string, status: number | null, stderr: string): void {
  console.log(label + ": exit " + status);
  console.log(stderr.trimEnd());
}

function maybe(which: string): NodeJS.WriteStream | undefined {
  return which === "out" ? process.stdout : undefined;
}

if (process.argv[2] === "child") {
  const input = process.stdin;
  const { isTTY, isRaw } = process.stdin;
  const lines = [
    "stdin " +
      [
        text(process.stdin?.isTTY),
        text(process.stdin.isTTY),
        String(process.stdin?.isTTY === true),
        text(process.stdin?.isRaw),
        text(process.stdin?.fd),
        wants(process.stdin?.isTTY),
      ].join(", "),
    "alias " + [text(input.isTTY), text(input?.isTTY), String(input?.isTTY ?? "none")].join(", "),
    "pattern " + [text(isTTY), text(isRaw)].join(", "),
    "stdout " + describe(process.stdout),
    "stderr " + describe(process.stderr),
    "direct " +
      [
        text(process.stdout?.isTTY),
        text(process.stdout?.columns),
        text(process.stderr?.rows),
        text(process.stdout?.fd),
        text(process.stderr?.fd),
      ].join(", "),
    "maybe " + [text(maybe("out")?.isTTY), text(maybe("none")?.isTTY), text(maybe("out")?.columns ?? 80)].join(", "),
  ];
  process.stderr.write(lines.join("\n") + "\n");
} else {
  const self = [process.argv[1]!, "child"];
  const nulls = spawnSync(process.execPath, self, {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  report("the null device", nulls.status, nulls.stderr);
  const pipes = spawnSync(process.execPath, self, {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  report("pipes", pipes.status, pipes.stderr);
  const inherited = spawnSync(process.execPath, self, {
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
  });
  report("inherited", inherited.status, inherited.stderr);
}
