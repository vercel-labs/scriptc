// tty.WriteStream#getColorDepth and #hasColors on a terminal: every variable
// Node's rules read, alone, in pairs and in seeded groups, as an environment
// object; then the default (process.env), the call forms and the errors.
import type { WriteStream } from "node:tty";

const values: Record<string, string[]> = {
  FORCE_COLOR: ["", "0", "1", "2", "3", "true", "4"],
  NODE_DISABLE_COLORS: ["", "1"],
  NO_COLOR: ["", "1"],
  TERM: [
    "", "dumb", "xterm", "xterm-256color", "xterm-kitty", "xterm-truecolor", "Eterm", "cons25", "console",
    "cygwin", "dtterm", "gnome", "hurd", "jfbterm", "konsole", "kterm", "mlterm", "mosh", "putty", "st",
    "rxvt-unicode-24bit", "terminator", "rxvt", "screen-256color", "vt100", "vt220", "vt52", "linux", "ansi",
    "con80x25", "conx", "iterm-direct", "my-color-term", "tmux", "alacritty", "SCREEN", "Konsole", "ANSİ",
  ],
  TMUX: ["", "/tmp/tmux-0/default,1,0"],
  TF_BUILD: ["", "True"],
  AGENT_NAME: ["", "agent"],
  CI: ["", "true"],
  APPVEYOR: ["1"],
  BUILDKITE: ["1"],
  CIRCLECI: ["1"],
  DRONE: ["1"],
  GITEA_ACTIONS: ["1"],
  GITHUB_ACTIONS: ["1"],
  GITLAB_CI: ["1"],
  TRAVIS: ["1"],
  CI_NAME: ["codeship", "other"],
  TEAMCITY_VERSION: ["", "9.0.1.", "9.1.2", "9.01.", "9.00.", "10.0", "2023.05.1", "8.1.", "9.", "123."],
  TERM_PROGRAM: ["iTerm.app", "HyperTerm", "MacTerm", "Apple_Terminal", "vscode", ""],
  TERM_PROGRAM_VERSION: ["", "2.9.1", "3.4.19", "0.1"],
  COLORTERM: ["", "truecolor", "24bit", "yes"],
};
const names = Object.keys(values);
const out = process.stdout;
const lines: string[] = [];

let seed = 20261108;
function next(limit: number): number {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed % limit;
}

function row(env: Record<string, string>): void {
  const depth = out.getColorDepth(env);
  lines.push(`${JSON.stringify(env)} ${depth} ${out.hasColors(16, env)} ${out.hasColors(256, env)} ${out.hasColors(2 ** 24, env)}`);
}

row({});
for (const a of names) for (const va of values[a]!) row({ [a]: va });
for (const a of names) {
  for (const b of names) {
    if (a >= b) continue;
    for (const va of values[a]!) for (const vb of values[b]!) row({ [a]: va, [b]: vb });
  }
}
for (let i = 0; i < 1500; i++) {
  const env: Record<string, string> = {};
  const count = 1 + next(7);
  for (let j = 0; j < count; j++) {
    const name = names[next(names.length)]!;
    const list = values[name]!;
    env[name] = list[next(list.length)]!;
  }
  row(env);
}

function attempt(label: string, run: () => unknown): void {
  try {
    const value = run();
    lines.push(`${label}: ${typeof value} ${String(value)}`);
  } catch (error) {
    const failure = error as { name?: string; code?: string; message?: string };
    lines.push(`${label}: threw ${failure.name} ${failure.code} ${failure.message}`);
  }
}

function depthOf(sink: WriteStream, env?: object): number {
  return sink.getColorDepth?.(env) ?? -1;
}

attempt("default stdout", () => process.stdout.getColorDepth());
attempt("default stderr", () => process.stderr.getColorDepth());
attempt("default has", () => `${process.stdout.hasColors()} ${process.stdout.hasColors(256)} ${process.stderr.hasColors(2 ** 24)}`);
attempt("process.env", () => process.stdout.getColorDepth(process.env));
attempt("spread", () => process.stdout.getColorDepth({ ...process.env, FORCE_COLOR: "3" }));
attempt("optional", () => depthOf(process.stdout, { COLORTERM: "24bit" }));
attempt("optional default", () => depthOf(process.stderr) === process.stderr.getColorDepth());
attempt("own undefined ci", () => process.stdout.getColorDepth({ CI: undefined, TERM: "xterm" }));
attempt("own undefined teamcity", () => process.stdout.getColorDepth({ TEAMCITY_VERSION: undefined, TERM: "xterm" }));
attempt("own undefined force", () => process.stdout.getColorDepth({ FORCE_COLOR: undefined, TERM: "xterm" }));
attempt("numbers", () => process.stdout.getColorDepth({ TERM: 5, FORCE_COLOR: 1 }));
attempt("tmux zero", () => process.stdout.getColorDepth({ TMUX: 0, TERM: "xterm" }));
attempt("teamcity number", () => process.stdout.getColorDepth({ TEAMCITY_VERSION: 10.5 }));
// A value that carries its own toString or valueOf is converted with it, once
// for each regular expression that reads it, and what it throws leaves the call.
let conversions = 0;
attempt("own text", () => process.stdout.getColorDepth({ TERM: { toString() { conversions++; return "xterm-256color"; } } }));
lines.push(`conversions ${conversions}`);
attempt("own text has", () => process.stdout.hasColors(256, { TERM: { toString() { return "xterm-256color"; } } }));
attempt("own text plain", () => process.stdout.getColorDepth({ TERM: { toString() { conversions++; return "plain"; } } }));
lines.push(`conversions ${conversions}`);
attempt("own text throws", () => process.stdout.getColorDepth({ TERM: { toString() { throw new RangeError("no text here"); } } }));
attempt("own text throws has", () => process.stdout.hasColors(16, { TERM: { toString() { throw new RangeError("no text here"); } } }));
attempt("own value", () => process.stdout.getColorDepth({ TERM: { toString: undefined, valueOf() { return "xterm-truecolor"; } } }));
attempt("own version", () => process.stdout.getColorDepth({ TEAMCITY_VERSION: { toString() { return "10.5"; } } }));
attempt("own program version", () => process.stdout.getColorDepth({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: { toString() { return "2.9"; } } }));
attempt("no text at all", () => process.stdout.getColorDepth({ TERM: { toString: undefined, valueOf: undefined } }));
let reads = 0;
attempt("accessor", () => process.stdout.getColorDepth({ get TERM(): string { reads++; return "xterm"; } }));
lines.push(`reads ${reads}`);
attempt("null", () => process.stdout.getColorDepth(null as unknown as object));
attempt("has env only", () => process.stdout.hasColors({ FORCE_COLOR: "3" }));
attempt("has one", () => process.stdout.hasColors(1));
attempt("has fraction", () => process.stdout.hasColors(2.5));
attempt("has nan", () => process.stdout.hasColors(NaN));
attempt("has huge", () => process.stdout.hasColors(2 ** 53));
attempt("has string", () => process.stdout.hasColors("x" as unknown as number));
attempt("has null", () => process.stdout.hasColors(null as unknown as number));
attempt("has undefined then env", () => process.stdout.hasColors(undefined as unknown as number, { FORCE_COLOR: "2" }));
attempt("has null env", () => process.stdout.hasColors(16, null as unknown as object));

process.on("warning", (warning) => {
  lines.push(`warning ${warning.name}: ${warning.message}`);
});
attempt("warned", () => process.stdout.getColorDepth({ FORCE_COLOR: "2", NODE_DISABLE_COLORS: "1", NO_COLOR: "1" }));
attempt("warned once", () => process.stdout.getColorDepth({ FORCE_COLOR: "1", NO_COLOR: "1" }));
setImmediate(() => {
  process.stdout.write(lines.join("\n") + "\n");
});
