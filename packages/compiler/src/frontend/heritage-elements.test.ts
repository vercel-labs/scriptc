import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { collectContractAnnotations } from "./contract-types.js";
import { isHeritageElement, heritageElementTarget } from "./heritage-elements.js";
import * as ts from "./ts7/adapter.js";
import { Ts7Api } from "./ts7/api.js";
import { Ts7Host } from "./ts7/program-host.js";
import { Ts7RpcClient } from "./ts7/rpc-client.js";
import { TS7_FILE_SYSTEM_CALLBACKS } from "./ts7/rpc-filesystem.js";
import { spawnTs7Wire } from "./ts7/rpc-process.js";
import { ts7TestServers, type Ts7TestServer } from "./ts7/test-servers.js";

const corpus = fileURLToPath(new URL("../../../../tests/corpus/", import.meta.url));

/** Corpus programs whose classes implement contract markers and interfaces. */
const programs = [
  "4636-contract-program-lifetime-references.ts",
  "5010-lifetime-region-generations.ts",
  "7401-program-lifetime-array-teardown.ts",
];

function host(server: Ts7TestServer): Ts7Host {
  return new Ts7Host(
    (options) =>
      new Ts7Api(
        new Ts7RpcClient(
          spawnTs7Wire(server.executable, [
            "--api",
            "--cwd",
            options.cwd,
            `--callbacks=${TS7_FILE_SYSTEM_CALLBACKS}`,
          ]),
        ),
        options.fs,
        options.collectTiming,
      ),
    { cwd: dirname(corpus) },
  );
}

/** Each heritage element's clause token, kind and the text it refers to,
 * and the program's contract annotations. */
function facts(server: Ts7TestServer, file: string) {
  const programHost = host(server);
  try {
    const program = programHost.createProgram([corpus + file], {
      strict: true,
      types: [],
      target: ts.ScriptTarget.ESNext,
    });
    const source = program.getSourceFile(corpus + file)!;
    const elements: string[] = [];
    ts.walkPreorder(source, (node) => {
      if (!isHeritageElement(node)) return undefined;
      const clause = node.parent as ts.HeritageClause;
      elements.push(
        `${clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends"} ${ts.getTextOfNode(heritageElementTarget(node))}`,
      );
      return undefined;
    });
    const contracts = collectContractAnnotations(program.getTypeChecker(), [source]);
    return {
      elements,
      classes: [...contracts.classes.values()].map((note) => `${note.marker} ${note.name}`),
      acyclic: contracts.acyclic.map((entry) => entry.note.name),
      diagnostics: contracts.diagnostics.map((diagnostic) => diagnostic.code),
    };
  } finally {
    programHost.close();
  }
}

test("heritage elements and the contracts they name read the same from tsc 7.0 and tsc 7.1", () => {
  const [old, next] = ts7TestServers();
  for (const file of programs) {
    const expected = facts(old!, file);
    expect(expected.classes.length, file).toBeGreaterThan(0);
    expect(expected.diagnostics, file).toEqual([]);
    expect(facts(next!, file), file).toEqual(expected);
  }
});
