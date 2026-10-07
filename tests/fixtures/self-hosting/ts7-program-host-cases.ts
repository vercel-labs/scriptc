import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FrontendInputTracker, trackedRealpath, trackedReadFile } from "../../../packages/compiler/src/frontend/input-tracker.js";
import { findConfigFile, getPreEmitDiagnostics, sys, type Ts7Host, type Ts7HostOptions } from "../../../packages/compiler/src/frontend/ts7/program-host.js";
import { ModuleDetectionKind, ModuleKind, ModuleResolutionKind, ScriptTarget } from "../../../packages/compiler/src/frontend/ts7/enums.js";
import { isVariableStatement, isIdentifier } from "../../../packages/compiler/src/frontend/ts7/ast-guards.generated.js";

function check(value: boolean, label: string): void {
  if (!value) throw new Error(label);
}

export function runProgramHost(createHost: (options: Ts7HostOptions) => Ts7Host, directory: string, report: string): void {
  const entry = join(directory, "main.ts");
  const dep = join(directory, "dep.ts");
  const virtual = join(directory, "virtual.ts");
  const hidden = join(directory, "hidden.ts");
  const shadow = join(directory, "shadow.ts");
  const config = join(directory, "tsconfig.json");
  const expected = 'import { dep } from "./dep.js";\nexport const answer: number = dep;\n';
  writeFileSync(entry, "\ufeff" + expected);
  writeFileSync(dep, "export const dep = 42;\n");
  writeFileSync(hidden, "export const hidden = true;\n");
  writeFileSync(shadow, "INVALID TYPESCRIPT !\n");
  writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, types: [] as string[] }, files: [entry] }));
  const host = createHost({
    cwd: directory, collectTiming: true,
    fsShadow: {
      readFile: (file) => file.replace(/\\/g, "/") === shadow.replace(/\\/g, "/") ? "\ufeffexport const shadow = 7;\n" : undefined,
      hideFile: (file) => file.replace(/\\/g, "/") === hidden.replace(/\\/g, "/"),
    },
  });
  try {
    host.addVirtualFile(virtual, '\ufeffexport const virtual = "hello";\n');
    const parsed = host.parseConfigFile(config);
    check(parsed.fileNames.some((file) => basename(file) === "main.ts"), "config parsing");
    check(parsed.options["strict"] === true, "config options");
    const tracker = new FrontendInputTracker();
    const program = tracker.run(() => host.createProgram([entry, virtual, shadow], {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      moduleDetection: ModuleDetectionKind.Force,
      strict: true, noEmit: true, types: [], lib: ["lib.es2025.d.ts"],
    }));
    try {
      check(getPreEmitDiagnostics(program).length === 0, "valid program diagnostics");
      check(program.getCompilerOptions().target === ScriptTarget.ESNext, "serialized ESNext target");
      check(program.getCompilerOptions().module === ModuleKind.ESNext, "serialized module");
      check(program.getCompilerOptions().moduleResolution === ModuleResolutionKind.Bundler, "serialized resolution");
      const source = program.getSourceFile(entry)!;
      check(source.text === expected, "disk BOM stripping");
      check(program.getSourceFile(virtual)!.text.startsWith("export"), "virtual BOM stripping");
      check(program.getSourceFile(shadow)!.text === "export const shadow = 7;\n", "shadow BOM stripping");
      check(program.getSourceFile(hidden) === undefined, "hidden file");
      check(program.getSourceFileNames().some((file) => basename(file) === "dep.ts"), "module resolution");
      const implementations = program.getImplementationSourceFiles();
      check(implementations.length > 0 && implementations.every((file) => !file.isDeclarationFile), "implementation source selection");
      check(implementations === program.getImplementationSourceFiles(), "implementation source cache");
      check(implementations.some((file) => file === source), "implementation source identity");
      check(program.getSourceFiles() === program.getSourceFiles(), "source file cache");
      const checker = program.getTypeChecker();
      check(checker === program.getTypeChecker(), "checker cache");
      const statement = source.statements[1]!;
      check(isVariableStatement(statement), "variable statement");
      if (isVariableStatement(statement)) {
        const name = statement.declarationList.declarations[0]!.name;
        check(name !== undefined && isIdentifier(name), "variable identifier");
        if (name !== undefined && isIdentifier(name)) {
          const type = checker.getTypeAtLocation(name);
          check(checker.typeToString(type) === "number", "native program checker");
          check(checker.getTypeAtLocation(name) === type, "checker identity");
        }
      }
      check(!program.isSourceFileDefaultLibrary(source), "user source classification");
      check(!program.isSourceFileFromExternalLibrary(source), "user dependency classification");
      check(program.getSourceFiles().some((file) => program.isSourceFileDefaultLibrary(file)), "default library classification");
      check(program.getSemanticDiagnostics(source).length === 0, "source semantic diagnostics");
      check(program.getSyntacticDiagnostics(source).length === 0, "source syntactic diagnostics");
      const snapshot = tracker.snapshot();
      check(snapshot.stable, "stable tracked program inputs");
      check(snapshot.probes.some((probe) => probe.op === "file" && basename(probe.path) === "dep.ts"), "tracked module read");
      check(!snapshot.probes.some((probe) => basename(probe.path) === "virtual.ts"), "virtual input stays virtual");
      const bad = join(directory, "bad.ts");
      host.addVirtualFile(bad, 'export const failure: number = "bad";\n');
      const other = host.createProgram([bad], { strict: true, noEmit: true, types: [] });
      try {
        check(other.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 2322), "second program diagnostics");
        check(getPreEmitDiagnostics(other).some((diagnostic) => diagnostic.code === 2322), "aggregate diagnostics");
        check(program.getSemanticDiagnostics().length === 0, "first snapshot survives second program");
      } finally { other.dispose(); }
      check(program.getSourceFile(entry) === source, "first snapshot remains live");
      host.addVirtualFile(virtual, "export const virtual = 123;\n");
      const updated = host.createProgram([virtual], { strict: true, noEmit: true, types: [] });
      try {
        check(updated.getSourceFile(virtual)!.text === "export const virtual = 123;\n", "virtual source update");
        check(program.getSourceFile(virtual)!.text.includes("hello"), "old virtual snapshot");
      } finally { updated.dispose(); }
    } finally { program.dispose(); }
    program.dispose();
    let refused = false;
    try { program.getSourceFiles(); } catch { refused = true; }
    check(refused, "disposed source cache");
    refused = false;
    try { program.getImplementationSourceFiles(); } catch { refused = true; }
    check(refused, "disposed implementation source cache");
    refused = false;
    try { program.getTypeChecker(); } catch { refused = true; }
    check(refused, "disposed checker cache");
    check(host.getTimingInfo().totals.sourceFilesFetched > 0, "host timing");
    check(findConfigFile(directory) === config, "nearest config search");
    check(findConfigFile(directory, (file) => file.length < 0) === undefined, "missing config search");
    check(sys.fileExists(entry) && sys.directoryExists(directory), "shared system filesystem");
    const written = join(directory, "written.txt");
    sys.writeFile(written, "written");
    check(sys.readFile(written) === "written", "shared system read/write");
    check(sys.readFile(written + ".missing") === undefined, "shared system missing read");
    check(sys.getCurrentDirectory() === process.cwd() && sys.newLine === "\n", "shared system process");
    const paths = new FrontendInputTracker();
    paths.run(() => {
      check(trackedRealpath(entry) !== null, "native realpath");
      check(trackedReadFile(entry) !== null, "tracked repeat read");
      check(trackedReadFile(entry) !== null, "stable duplicate read");
    });
    check(paths.snapshot().stable, "duplicate probes stay stable");
    writeFileSync(entry, "export const changed = true;\n");
    paths.run(() => { trackedReadFile(entry); });
    check(!paths.snapshot().stable, "changed probes are unstable");
  } finally { host.close(); host.close(); }
  let refused = false;
  try { host.createProgram([entry], {}); } catch { refused = true; }
  check(refused, "closed host cannot create programs");
  writeFileSync(report, JSON.stringify({
    config: true, sourceFiles: true, checker: true, diagnostics: true,
    virtualFiles: true, shadows: true, snapshots: true, inputs: true,
    filesystem: true, disposal: true,
  }));
}
