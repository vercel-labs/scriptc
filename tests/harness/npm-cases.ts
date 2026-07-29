/* The npm differential case table — npm.test.ts's list, extracted so the
 * Linux lane runs the IDENTICAL cases (same entries, same argv lists)
 * against the in-container Linux Node oracle. The fixture node_modules
 * are COMMITTED TEST DATA; binaries embed the package sources at build
 * time, the Node lane resolves them from the repo mount. */
import { globSync } from "node:fs";
import { join } from "node:path";

export interface NpmCase {
  name: string;
  entry: string;
  /** Every argv list runs both sides; default: one run with no args. */
  argvs?: string[][];
}

export function npmCases(fixturesRoot: string): NpmCase[] {
  return [
    ...globSync(join(fixturesRoot, "npm/cases/*/main.ts"))
      .sort()
      // 2465-2469 and 2556-2557 are the --npm-static bundler-emitted-CJS
      // cases (npm-static.test.ts drives them with the opt-in): their
      // consumers exercise the static rewrite's surface (lexer-visible
      // names the shipped .d.ts never declares, the __toESM interop
      // family), so they stay out of the flagless island lane by design.
      .filter((entry) => !/\/(246[5-9]|255[67])-[^/]+\/main\.ts$/.test(entry))
      .map((entry) => ({ name: entry.split("/").at(-2)!, entry })),
    {
      name: "workspace-typeless-require",
      entry: join(fixturesRoot, "npm/cases/workspace-typeless/require.ts"),
    },
    {
      name: "workspace-typeless-warning-event",
      entry: join(fixturesRoot, "npm/cases/workspace-typeless/warning-event.ts"),
    },
    {
      name: "workspace-typeless-two-warnings",
      entry: join(fixturesRoot, "npm/cases/workspace-typeless/two-warnings.ts"),
    },
    {
      // THE acceptance test: a calculator CLI on the real commander package
      // (pinned in the fixture; see its README), across the happy paths,
      // --version/--help (island process.exit), and the error exits.
      name: "commander-calc",
      entry: join(fixturesRoot, "commander-calc/calc.ts"),
      argvs: [
        ["add", "2", "3"],
        ["sub", "10", "4.25"],
        ["mul", "4", "2.5"],
        ["div", "9", "2"],
        ["add", "0.1", "0.2"],
        ["add", "1e3", "-0.5"],
        // The typed async action (string|undefined + options record + async
        // body): omitted argument -> the undefined arm; option flags ->
        // record fields (missing ones take their undefined arms); the
        // trailing Command argument drops.
        ["echo", "hello"],
        ["echo"],
        ["echo", "hello", "--upper"],
        ["echo", "hello", "-p", "say: "],
        ["echo", "--upper", "-p", "p: ", "mixed"],
        ["--version"],
        ["--help"],
        ["add", "2"], // missing argument: usage error, exit 1
        ["boom"], // unknown command: suggestion error, exit 1
        [], // no command: help to stderr, exit 1
        // The rejecting async action under plain parse(): nobody observes
        // the rejection — the unhandled-rejection report fires, exit 1.
        ["fail", "flat tire"],
      ],
    },
    {
      // The classic CLI ENTRY LINE: parseAsync's engine promise bridges into a
      // static one; the rejecting async action reaches the inline .catch
      // handler (typed-catch narrowing, stderr message, exit 1) — the full
      // round trip through BOTH promise bridges (the action's static
      // promise wraps into the engine, commander's result promise bridges
      // back out).
      name: "commander-calc-async",
      entry: join(fixturesRoot, "commander-calc/calc-async.ts"),
      argvs: [
        ["double", "21"],
        ["fail", "flat tire"],
        ["--help"],
        ["boom"], // unknown command: island process.exit path, exit 1
      ],
    },
  ];
}
