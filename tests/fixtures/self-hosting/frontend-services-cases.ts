import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FrontendServices } from "../../../packages/compiler/src/frontend/services.js";
import { parseNpmStaticDeclarationOverloads, parseNpmStaticDeclarationProperties } from "../../../packages/compiler/src/frontend/npm-static-declaration-syntax.js";
import { isVariableStatement, isIdentifier } from "../../../packages/compiler/src/frontend/ts7/syntax.js";
import { NodePackageResolver } from "../../../packages/compiler/src/frontend/npm.js";

function check(value: boolean, reason: string): void { if (!value) throw new Error(reason); }

export function runFrontendServices(services: FrontendServices, input: string, output: string): void {
  const request = JSON.parse(readFileSync(input, "utf8")) as {
    directory: string;
    declarations: string;
    source: string;
    bundled: string;
  };
  const declarationFile = services.parse("package.d.ts", request.declarations, "ts");
  const methods = parseNpmStaticDeclarationOverloads(declarationFile);
  const properties = parseNpmStaticDeclarationProperties(declarationFile);
  const nullable = services.nullableClassFields("package.js", request.source);
  const widened = services.findReturnWidening("package.js", nullable?.text ?? request.source);
  const namepaths = services.jsDocNamepaths("package.js", "/** @returns {Array<Box~Item>} */ function items() { return []; }");
  check(namepaths !== null && namepaths.includes("Array<*"), "checked JSDoc namepaths");
  const fields = services.declarationProperties("package.js", widened?.text ?? nullable?.text ?? request.source, properties);
  const overloads = services.declarationOverloads("package.js", fields?.text ?? widened?.text ?? nullable?.text ?? request.source, methods);
  const rewritten = services.rewriteCjs(request.bundled, join(request.directory, "bundle.js"));
  check(typeof rewritten === "string", "bundled rewrite");
  const original = services.parse("edited.ts", "export const original = 1;", "ts");
  const changed = services.parse("edited.ts", "export const changed = 2;", "ts");
  check(original.text.includes("original") && changed.text.includes("changed"), "detached syntax versions");

  const resolver = new NodePackageResolver();
  const entry = join(request.directory, "main.ts");
  const resolved = resolver.resolveForIntrospection(entry, "service-fetch", "require");
  check(resolved !== null, "package entry resolution");

  const host = services.createProgramHost({ cwd: request.directory });
  const sourcePath = join(request.directory, "virtual.ts");
  try {
    host.addVirtualFile(sourcePath, "export const version = 1;");
    const before = host.createProgram([sourcePath], { noLib: true, types: [] });
    try {
      const source = before.getSourceFile(sourcePath)!;
      const statement = source.statements.nodes[0]!;
      check(isVariableStatement(statement), "native statement view");
      if (isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.nodes[0]!;
        const name = declaration.name;
        check(isIdentifier(name), "native binding view");
        if (isIdentifier(name)) {
          check(before.getTypeChecker().typeToString(before.getTypeChecker().getTypeAtLocation(name)) === "1", "native checker literal");
        }
        before.analysis.createRequireReasons.set(declaration, "owned by old program");
      }
      before.analysis.nodeEsmFiles.set(source, true);
      host.addVirtualFile(sourcePath, "export const version = 2;");
      const after = host.createProgram([sourcePath], { noLib: true, types: [] });
      try {
        check(after.analysis.nodeEsmFiles.size === 0, "new snapshot has no old format decisions");
        check(after.analysis.createRequireReasons.size === 0, "new snapshot has no old binding decisions");
        check(after.getSourceFile(sourcePath)!.text.includes("2"), "updated program source");
        check(before.getSourceFile(sourcePath) === source && source.text.includes("1"), "old program source remains live");
      } finally { after.dispose(); }
    } finally { before.dispose(); }
    check(before.analysis.nodeEsmFiles.size === 0 && before.analysis.createRequireReasons.size === 0, "disposed analysis state");
    // Closing syntax services does not close a host explicitly owned by this caller.
    services.close();
    check(original.text === "export const original = 1;", "detached AST survives service close");
    const independent = host.createProgram([sourcePath], { noLib: true, types: [] });
    try { check(independent.getSourceFile(sourcePath)!.text.includes("2"), "host survives service close"); }
    finally { independent.dispose(); }
  } finally { host.close(); }
  let closed = false;
  try { services.parse("closed.ts", "", "ts"); } catch { closed = true; }
  check(closed, "closed syntax refusal");
  services.close();
  writeFileSync(output, JSON.stringify({
    nullable, widened, fields, overloads, rewritten, resolved,
    versions: [original.text, changed.text], closed,
  }));
}
