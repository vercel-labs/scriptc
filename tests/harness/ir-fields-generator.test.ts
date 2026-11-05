import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { generateIrFields } from "../../scripts/generate-ir-fields.mjs";

const compilerDir = join(import.meta.dirname, "../../packages/compiler");
const irPath = join(compilerDir, "src/ir/ir.ts");
const generatedPath = join(compilerDir, "src/ir/fields.generated.ts");
const irText = readFileSync(irPath, "utf8");
const arrayGet = '{ kind: "arrayGet"; arr: IrExpr; index: IrExpr; type: IrType; loc: SrcLoc }';

/** ir.ts with `field` added to the arrayGet node. */
function withArrayGetField(field: string): string {
  expect(irText).toContain(arrayGet);
  return irText.replace(arrayGet, arrayGet.replace("loc: SrcLoc }", `loc: SrcLoc; ${field} }`));
}

/** The type errors of `generated` as fields.generated.ts, with `ir` as ir.ts,
 * under the compiler package's options. */
function generatedErrors(ir: string, generated: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(compilerDir, "tsconfig.json"),
    { noEmit: true, incremental: false },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )!;
  const host = ts.createCompilerHost(parsed.options);
  const readSourceFile = host.getSourceFile;
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file === irPath
      ? ts.createSourceFile(file, ir, languageVersion)
      : file === generatedPath
        ? ts.createSourceFile(file, generated, languageVersion)
        : readSourceFile.call(host, file, languageVersion, ...rest);
  const program = ts.createProgram([generatedPath], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(generatedPath))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("a nested record of scalar fields passes the checks once the readers are regenerated", () => {
  const ir = withArrayGetField("counts?: { hits: number; misses: number | undefined }");
  expect(generatedErrors(ir, generateIrFields(ir))).toEqual([]);
});

test("the record's own fields are checked: an added field or a widened scalar fails with its name", () => {
  const generated = generateIrFields(
    withArrayGetField("counts?: { hits: number; misses: number | undefined }"),
  );
  const added = generatedErrors(
    withArrayGetField("counts?: { hits: number; misses: number | undefined; label: string }"),
    generated,
  );
  expect(added).toEqual([`Type '"label"' does not satisfy the constraint 'never'.`]);
  const widened = generatedErrors(
    withArrayGetField("counts?: { hits: number | string; misses: number | undefined }"),
    generated,
  );
  expect(widened).toEqual([`Type 'string' does not satisfy the constraint 'never'.`]);
});
