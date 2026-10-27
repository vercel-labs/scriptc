import { CheckerFacade, constituentTypes } from "../../../packages/compiler/src/frontend/ts7/checker.js";
import type { SourceFile } from "../../../packages/compiler/src/frontend/ts7/ast-types.js";
import { Ts7RpcClient } from "../../../packages/compiler/src/frontend/ts7/rpc-client.js";
import { registerTs7FileSystem } from "../../../packages/compiler/src/frontend/ts7/rpc-filesystem.js";
import { Ts7Session } from "../../../packages/compiler/src/frontend/ts7/session.js";
import { join } from "node:path";

function check(value: boolean, message: string): void {
  if (!value) throw new Error(`Checker snapshot: ${message}`);
}

function protocolPath(path: string): string {
  return process.platform === "win32" ? path.split("\\").join("/") : path;
}

function exportedName(source: SourceFile) {
  return source.statements.nodes[1]!.declarationList!.declarations?.nodes[0]!.name!;
}

/** Reuse one server, one source version and both old/new semantic graphs.
 * The same AstNode must key different answers in different facades even
 * when the server reuses the same numeric type/symbol handles. */
export function checkCheckerSnapshots(session: Ts7Session, client: Ts7RpcClient, directory: string): void {
  const config = protocolPath(join(directory, "checker-snapshots.json"));
  const otherConfig = protocolPath(join(directory, "checker-other.json"));
  const main = protocolPath(join(directory, "checker-main.ts"));
  const dependency = protocolPath(join(directory, "checker-dependency.ts"));
  let value = 'export const value: number | null = 1;';
  const configText = JSON.stringify({
    compilerOptions: { strict: true, target: "esnext", types: [] as string[] },
    files: [main],
  });
  registerTs7FileSystem(client, {
    readFile: (path) => {
      if (path === config || path === otherConfig) return configText;
      if (path === main) return 'import { value } from "./checker-dependency.js"; export const result = value;';
      if (path === dependency) return value;
      return undefined;
    },
    fileExists: (path) => path === config || path === otherConfig || path === main || path === dependency ? true : undefined,
    directoryExists: () => undefined,
    realpath: () => undefined,
    getAccessibleEntries: () => undefined,
  });
  const first = session.updateSnapshot({ openProjects: [config, otherConfig] });
  const project = first.getProject(config)!;
  const other = first.getProject(otherConfig)!;
  const source = project.program.getSourceFile(main)!;
  check(other.program.getSourceFile(main) === source, "simultaneous projects share source identity");
  const name = exportedName(source);
  const old = new CheckerFacade(project.checker, { project: project.checker.project });
  const sibling = new CheckerFacade(other.checker, { project: other.checker.project });
  const oldType = old.getTypeAtLocation(name);
  const siblingType = sibling.getTypeAtLocation(name);
  check(oldType !== siblingType, "project-local type identity");
  check(old.typeToString(oldType) === "number | null", "original result");
  check(sibling.typeToString(siblingType) === "number | null", "sibling result");
  const oldArms = constituentTypes(oldType);
  const siblingArms = constituentTypes(siblingType);
  check(oldArms.length === 2 && siblingArms.length === 2, "original constituents");
  check(oldArms !== siblingArms && oldArms[0] !== siblingArms[0], "project-local constituents");
  const oldSymbol = old.getSymbolAtLocation(name)!;
  const oldDeclaration = oldSymbol.valueDeclaration!;
  check(oldDeclaration.name === name, "resolved declaration identity");

  value = 'export const value: string | null = "new";';
  const second = session.updateSnapshot({ fileChanges: { changed: [dependency] } });
  const updatedProject = second.getProject(config)!;
  const updatedSource = updatedProject.program.getSourceFile(main)!;
  check(updatedSource === source && exportedName(updatedSource) === name, "dependency update reuses AST nodes");
  const next = new CheckerFacade(updatedProject.checker, { project: updatedProject.checker.project });
  const newType = next.getTypeAtLocation(name);
  const newSymbol = next.getSymbolAtLocation(name)!;
  check(next.typeToString(newType) === "string | null", "new snapshot result");
  check(newType !== oldType && newSymbol !== oldSymbol, "independent semantic identities");
  check(newSymbol.valueDeclaration === oldDeclaration, "declarations retain shared syntax identity");
  check(next.getTypeOfSymbol(newSymbol) === newType, "new symbol answer");
  check(old.getTypeOfSymbol(oldSymbol) === oldType, "old symbol answer");
  check(old.getTypeAtLocation(name) === oldType && old.typeToString(oldType) === "number | null", "old snapshot stays immutable");
  check(constituentTypes(oldType) === oldArms, "old constituent memo retained");
  const newArms = constituentTypes(newType);
  check(newArms.length === 2 && newArms !== oldArms, "new constituent memo");
  check(next.isTypeAssignableTo(next.getStringType(), newType), "new snapshot assignability");
  check(!next.isTypeAssignableTo(next.getNumberType(), newType), "new snapshot negative assignability");
  check(old.isTypeAssignableTo(old.getNumberType(), oldType), "old snapshot assignability");

  // Explicitly disposing one facade must preserve the project and a
  // sibling facade, while retiring the project invalidates both of them.
  const replacement = new CheckerFacade(project.checker, { project: project.checker.project });
  check(replacement.getTypeAtLocation(name) === oldType, "replacement facade shares project registry");
  old.dispose();
  old.dispose();
  let refusals = 0;
  try { old.getTypeAtLocation(name); } catch { refusals++; }
  check(replacement.getTypeAtLocation(name) === oldType, "replacement survives facade disposal");
  check(project.program.getSourceFile(main) === source, "source identity survives facade disposal");
  check(sibling.getTypeAtLocation(name) === siblingType, "sibling project survives facade disposal");
  first.dispose();
  try { replacement.getTypeAtLocation(name); } catch { refusals++; }
  try { sibling.getTypeAtLocation(name); } catch { refusals++; }
  try { constituentTypes(oldType); } catch { refusals++; }
  try { constituentTypes(siblingType); } catch { refusals++; }
  check(refusals === 5, "retired snapshot rejects warm reads");
  check(next.getTypeAtLocation(name) === newType && constituentTypes(newType) === newArms, "next snapshot survives old disposal");
  check(next.isTypeAssignableTo(next.getStringType(), newType), "next assignability memo survives");
  second.dispose();
  try { next.getTypeAtLocation(name); } catch { refusals++; }
  try { next.getStringType(); } catch { refusals++; }
  try { constituentTypes(newType); } catch { refusals++; }
  check(refusals === 8, "second snapshot rejects warm reads");

  // Releasing the latest server snapshot retires its change baseline.
  // Its successor reloads source and constructs fresh semantic answers.
  const fetchedBefore = session.getTimingInfo().totals.sourceFilesFetched;
  const third = session.updateSnapshot();
  const latestProject = third.getProject(config)!;
  const latestSource = latestProject.program.getSourceFile(main)!;
  check(latestSource.text === source.text, "successor reloads unchanged source");
  check(session.getTimingInfo().totals.sourceFilesFetched === fetchedBefore + 1, "successor source is revalidated");
  const latestName = exportedName(latestSource);
  const latest = new CheckerFacade(latestProject.checker, { project: latestProject.checker.project });
  const latestType = latest.getTypeAtLocation(latestName);
  check(latestType !== newType && latest.typeToString(latestType) === "string | null", "successor rebuilds semantic answers");
  const before = client.timing().requests;
  check(latest.getTypeAtLocation(latestName) === latestType, "successor memo is warm");
  check(client.timing().requests === before, "successor warm read avoids RPC");
  third.dispose();
}
