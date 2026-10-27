import { checkerSource, checkCheckerFacade, checkDisposedChecker } from "./ts7-checker-cases.js";
import { checkCheckerSnapshots } from "./ts7-checker-snapshots.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ts7RpcClient } from "../../../packages/compiler/src/frontend/ts7/rpc-client.js";
import { registerTs7FileSystem } from "../../../packages/compiler/src/frontend/ts7/rpc-filesystem.js";
import { Ts7Wire } from "../../../packages/compiler/src/frontend/ts7/rpc-wire.js";
import { AstFile, AstNode, AstNodeList } from "../../../packages/compiler/src/frontend/ts7/ast-node.js";
import { AstKind, KIND_NODE_LIST, astChildNames } from "../../../packages/compiler/src/frontend/ts7/ast-schema.generated.js";
import { decodeAstString } from "../../../packages/compiler/src/frontend/ts7/ast-bytes.js";
import { SyntaxKind, ScriptTarget, ModuleKind, ModuleResolutionKind, ModuleDetectionKind, syntaxKindName, scriptTargetName, moduleKindName, moduleResolutionKindName, moduleDetectionKindName } from "../../../packages/compiler/src/frontend/ts7/enums.js";
import { Ts7Session } from "../../../packages/compiler/src/frontend/ts7/session.js";
import { Ts7Paths, ts7DocumentFile } from "../../../packages/compiler/src/frontend/ts7/session-path.js";
import { parseSemanticJson } from "../../../packages/compiler/src/frontend/ts7/semantic-json.js";
import { symbolName, symbolNameOf } from "../../../packages/compiler/src/frontend/ts7/semantic-model.js";
import { checkSemanticModel, semanticSource } from "./ts7-semantic-cases.js";
import { checkAstViews } from "./ts7-ast-views.js";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// The current native runtime documents replacing lone UTF-16 surrogates.
// Compiler input must never silently pass through that normalization. Keep
// this boundary explicit until native strings can retain every code unit.
function checkSurrogateBoundary(): string {
  const bytes = new Uint8Array([0xed, 0xa0, 0x80, 0xef, 0xbb, 0xbf]);
  try {
    const value = decodeAstString(bytes, 0, bytes.length);
    check(value.length === 2 && value.charCodeAt(0) === 0xd800 && value.charCodeAt(1) === 0xfeff, "lossless surrogate decode");
    return "preserved";
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "TypeScript AST: runtime cannot preserve lone UTF-16 surrogates") throw error;
    return "refused";
  }
}

function checkSemanticSurrogateBoundary(): string {
  check(parseSemanticJson<string>('"\\ud83c\\udf0d"') === "🌍", "semantic JSON surrogate pair");
  check(parseSemanticJson<string>('"\\\\ud800"') === "\\ud800", "semantic JSON escaped backslash");
  let refused = 0;
  const hex = "0123456789abcdef";
  for (let unit = 0xd800; unit <= 0xdfff; unit++) {
    try {
      const escape = hex.charAt((unit >> 12) & 15) + hex.charAt((unit >> 8) & 15) + hex.charAt((unit >> 4) & 15) + hex.charAt(unit & 15);
      const value = parseSemanticJson<string>('"\\u' + escape + '"');
      check(value.length === 1 && value.charCodeAt(0) === unit, "lossless semantic JSON code unit");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "TypeScript semantic response: runtime cannot preserve lone UTF-16 surrogates") throw error;
      refused++;
    }
  }
  check(refused === 0 || refused === 2048, "consistent semantic JSON surrogate boundary");
  return refused === 0 ? "preserved" : "refused";
}

function checkAst(ast: AstFile, source: string): void {
  check(ast.root.text === source, "decoded source text");
  check(ast.root.getSourceFile() === ast.root, "source identity");
  check(ast.root.statements?.nodes === ast.root.statements?.nodes, "stable child list nodes");
  for (let index = 1; index < ast.wire.nodeCount; index++) {
    if (ast.wire.kind(index) === KIND_NODE_LIST) { ast.list(index); continue; }
    const node = ast.node(index);
    check(ast.resolve(node.id) === node, "handle identity");
    check(syntaxKindName(node.kind) !== undefined, "native syntax kind names");
    check(node.getFullText() === source.substring(node.pos, node.end), "full text span");
    check(node.getText() === source.substring(node.getStart(), node.end), "token text span");
    check(node.getFullWidth() === node.end - node.pos, "full width");
    check(node.getWidth() === node.end - node.getStart(), "token width");
    check(node.getLeadingTriviaWidth() === node.getStart() - node.pos, "trivia width");
    check(node.getFullStart() === node.pos && node.getEnd() === node.end, "span endpoints");
    for (const name of astChildNames(node.kind).split(",")) {
      const child = node.child(name!);
      if (child instanceof AstNodeList) {
        for (const item of child.nodes) check(item.parent === node, "list child parent");
      } else if (child !== undefined) check(child.parent === node, "named child parent");
    }
    const seen: AstNode[] = [];
    node.forEachChild((child) => { seen.push(child); });
    check(node.forEachChild((child) => child.index) === seen[0]?.index, "visitor early return");
    let listElements = 0;
    node.forEachChild(() => {}, (list) => { listElements += list.nodes.length; });
    check(listElements <= seen.length, "array visitor");
    for (const doc of node.jsDoc ?? []) check(doc.kind === AstKind.JSDoc, "JSDoc children");
  }
  const lines = ast.root.getLineStarts();
  for (let position = 0; position <= source.length; position++) {
    const location = ast.root.getLineAndCharacterOfPosition(position);
    check(ast.root.getPositionOfLineAndCharacter(location.line, location.character) === position, "UTF16 line round trip");
    check(lines[location.line]! <= position, "line start");
  }
  check(ast.root.referencedFiles.length === 0 && ast.root.typeReferenceDirectives.length === 0 && ast.root.libReferenceDirectives.length === 0, "file references");
  check(ast.root.imports.length === 0 && ast.root.moduleAugmentations.length === 0 && ast.root.ambientModuleNames.length === 0, "structured arrays");
  check(ast.root.externalModuleIndicator !== undefined, "external module");
  check(ast.root.fileName.length > 0 && ast.root.languageVariant === 0 && !ast.root.isDeclarationFile, "source metadata");
}

// Exercise malformed inputs in the native executable too. The callbacks
// deliberately fragment transfers so framing cannot rely on whole reads.
function checkFailures(): void {
  for (const frame of [
    [0x92], [0x93, 7], [0x93, 4, 0xa0], [0x93, 4, 0xc4, 0, 0xc4],
    [0x93, 4, 0xc4, 0, 0xc6, 0xff, 0xff, 0xff, 0xff],
  ]) {
    const bytes = frame!;
    let offset = 0;
    let closes = 0;
    const wire = new Ts7Wire({
      read: (buffer, start) => {
        if (offset === bytes.length) return 0;
        buffer[start] = bytes[offset++]!;
        return 1;
      },
      write: (_buffer, _start, length) => length,
      close: () => { closes++; },
    });
    let failed = false;
    try { wire.read(); } catch { failed = true; }
    check(failed, "malformed frame refused");
    failed = false;
    try { wire.read(); } catch { failed = true; }
    check(failed, "malformed channel stays closed");
    wire.close();
    check(closes === 1, "malformed channel closes once");
  }
  // A successful callback reply may be empty; a throwing callback instead
  // sends kind 3, closes, and leaves the unread outer response untouched.
  for (const throws of [false, true]) {
    const bytes = new Uint8Array([0x93, 6, 0xc4, 1, 120, 0xc4, 0, 0x93, 4, 0xc4, 1, 113, 0xc4, 0]);
    const output: number[] = [];
    let offset = 0;
    let closes = 0;
    const local = new Ts7RpcClient(new Ts7Wire({
      read: (buffer, start) => {
        if (offset === bytes.length) return 0;
        buffer[start] = bytes[offset++]!;
        return 1;
      },
      write: (buffer, start) => { output.push(buffer[start]!); return 1; },
      close: () => { closes++; },
    }));
    local.registerCallback("x", () => {
      if (throws) throw new Error("callback failed");
      // Reject a nested request before it can put bytes on this stream.
      let nestedFailed = false;
      try { local.requestText("nested", ""); } catch { nestedFailed = true; }
      check(nestedFailed, "native callback reentry refused");
      return "";
    });
    let failed = false;
    try { local.requestText("q", ""); } catch { failed = true; }
    check(failed === throws, "callback failure propagation");
    check(output[8] === (throws ? 3 : 2), "callback reply kind");
    local.close();
    check(closes === 1, "callback channel closes once");
  }
}

export function runTs7Client(client: Ts7RpcClient, directory: string, report: string): void {
  checkFailures();
  check(SyntaxKind.SourceFile === AstKind.SourceFile && SyntaxKind.Identifier === AstKind.Identifier, "owned syntax enums");
  check(scriptTargetName(ScriptTarget.ESNext) === "Latest", "native target reverse alias");
  check(moduleKindName(ModuleKind.ESNext) === "ESNext", "native module name");
  check(moduleResolutionKindName(ModuleResolutionKind.Bundler) === "Bundler", "native resolution name");
  check(moduleDetectionKindName(ModuleDetectionKind.Force) === "Force", "native detection name");
  for (const invalid of [-100, 0.5, 65536]) {
    check(syntaxKindName(invalid) === undefined && scriptTargetName(invalid) === undefined && moduleKindName(invalid) === undefined,
      "unknown enum values remain undefined");
  }

  // Canonical protocol paths do not depend on the executable's host OS.
  const windowsPaths = new Ts7Paths("C:/Work", false);
  check(windowsPaths.canonical("..\\Lib\\File.ts") === "c:/lib/file.ts", "Windows path identity");
  check(new Ts7Paths("/work", true).canonical("bundled:///lib.esnext.d.ts") === "bundled:///lib.esnext.d.ts", "bundled path identity");
  check(ts7DocumentFile({uri: "file:///C%3A/dir/a%20b.ts"}) === "c:/dir/a b.ts", "file URI decoding");
  check(ts7DocumentFile({uri: "untitled:Untitled-1"}) === "^/untitled/ts-nul-authority/Untitled-1", "virtual URI decoding");

  function protocolPath(path: string): string {
    return process.platform === "win32" ? path.split("\\").join("/") : path;
  }
  const configPath = protocolPath(join(directory, "virtual.tsconfig.json"));
  const file = protocolPath(join(directory, "virtual.ts"));
  const empty = protocolPath(join(directory, "empty.ts"));
  const hidden = protocolPath(join(directory, "hidden.ts"));
  const disk = protocolPath(join(directory, "disk.ts"));
  let content = 'export const answer = 42;\nexport const greeting = "\\uFEFFhéllo 🌍";\n';
  content += '/** Box documentation. */\nexport class Box { readonly value = 2; method(n: number) { return n + this.value; } }\n';
  content += 'export const many = [';
  for (let index = 0; index < 40; index++) content += `${index},`;
  content += '];\nexport const template = `head\\n${answer}tail`;\n';
  content += semanticSource();
  content += checkerSource();
  let reads = 0;
  registerTs7FileSystem(client, {
    readFile: (path) => {
      reads++;
      if (path === configPath) return JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: "esnext", types: [] as string[] },
        files: [file, empty, hidden, disk],
      });
      if (path === file) return content;
      if (path === empty) return "";
      if (path === hidden) return null;
      return undefined;
    },
    fileExists: (path) => path === file || path === empty || path === configPath ? true : path === hidden ? false : undefined,
    directoryExists: () => undefined,
    realpath: () => undefined,
    getAccessibleEntries: () => undefined,
  });

  const session = new Ts7Session(client, true);
  try {
    const initialization = session.initialize();
    check(protocolPath(initialization.currentDirectory) === protocolPath(directory), "server working directory");
    const config = session.parseConfigFile(configPath);
    check(config.fileNames.includes(file), "virtual config roots");

    // Exercise all binary length encodings, including reads larger than the
    // channel buffer and NUL/non-UTF8 data that must not pass through strings.
    for (const length of [0, 1, 255, 256, 65535, 65536, 140000]) {
      const bytes = new Uint8Array(length!);
      for (let i = 0; i < length; i++) bytes[i] = (i * 31) % 256;
      const echoed = client.requestBytes("echo", bytes);
      check(echoed.length === bytes.length, "echo byte length");
      for (let i = 0; i < length; i++) check(echoed[i] === bytes[i], "echo byte contents");
    }
    check(client.requestText("echo", "\uFEFFhéllo\0🌍") === "\uFEFFhéllo\0🌍", "UTF8 echo");

    const snapshot = session.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath)!;
    check(snapshot.getProjects()[0] === project, "project registry identity");
    check(project.configFileName === configPath, "project identity");
    const names = project.program.getSourceFileNames();
    check(names.includes(file) && names.includes(empty) && names.includes(disk), "virtual, empty, and disk files");
    check(!names.includes(hidden), "hidden file remains absent");
    const root = project.program.getSourceFile(file)!;
    const tree = root.file;
    checkAstViews(tree);
    check(project.program.getSourceFile(file) === root, "cached source identity");
    check(project.program.getCompilerOptions().strict === true, "parsed compiler options");
    check(session.parseConfigFile(configPath).options["strict"] === true, "raw config option decoding");
    const uri = "file:///" + file.replace(/^\//, "");
    check(project.program.getSourceFile({uri}) === root, "document URI cache identity");
    check(project.program.getSourceFile(hidden) === undefined, "missing source response");
    const sourceRequests = client.timing().requests;
    check(project.program.getSourceFile(file) === root, "snapshot source lookup");
    check(project.program.getSourceFile(hidden) === undefined, "snapshot missing lookup");
    check(client.timing().requests === sourceRequests, "source hits and misses do not repeat requests");
    check(project.program.getSourceFileMetadata(file)!.isDefaultLibrary === false, "source metadata");
    check(!project.program.isSourceFileFromExternalLibrary(root) && !project.program.isSourceFileDefaultLibrary(root), "source library flags");
    checkAst(tree, content);
    const statements = tree.root.statements!.nodes;
    check(statements[1]!.declarationList!.declarations!.nodes[0]!.initializer!.text === "\uFEFFhéllo 🌍", "string BOM retained");
    const box = statements[2]!;
    check(box.getStart(undefined, true) < box.getStart() && box.members!.nodes.length === 2, "class JSDoc and members");
    check(box.members!.nodes[0]!.modifierFlags !== 0, "readonly modifier flag");
    check(statements[3]!.declarationList!.declarations!.nodes[0]!.initializer!.elements!.nodes.length === 40, "long native node list");
    const template = statements[4]!.declarationList!.declarations!.nodes[0]!.initializer!;
    check(template.head!.text === "head\n" && template.head!.rawText === "head\\n", "cooked and raw template text");
    check(project.program.getSemanticDiagnostics(file).length === 0, "valid program diagnostics");
    check(project.program.getSyntacticDiagnostics(file).length === 0 && project.program.getBindDiagnostics(file).length === 0, "parse and bind diagnostics");
    const declaration = root.statements.nodes[0]!.declarationList!.declarations?.nodes[0]!;
    const identifier = declaration.name!;
    const checker = project.checker;
    const ownedType = checker.getTypeAtLocation(identifier)!;
    const ownedSymbol = checker.getSymbolAtLocation(identifier)!;
    const typeText = checker.typeToString(ownedType);
    check(checker.getTypeAtPosition(file, content.indexOf("answer")) === ownedType, "semantic type identity");
    check(checker.getSymbolAtPosition(file, content.indexOf("answer")) === ownedSymbol, "semantic symbol identity");
    check(ownedSymbol.declarationHandles[0]!.resolve() === declaration, "semantic declaration identity");
    check(typeText === "42" && ownedType.isNumberLiteralType() && ownedType.value === 42, "semantic literal metadata");
    // The semantic exercise disposes its graph; the session still owns the
    // server snapshot and its program until explicit snapshot disposal.
    const facade = checkCheckerFacade(checker, root, () => client.timing().requests);
    checkSemanticModel(snapshot.semantic, checker, tree);
    checkDisposedChecker(facade, root);

    // A server-side refusal completes its request. It must not poison the
    // channel: the frontend's checker panic fence relies on this recovery.
    let refused = false;
    try { client.requestText("scriptcUnknownMethod", "null"); }
    catch { refused = true; }
    check(refused, "server error surfaces");
    check(client.requestText("echo", "after error") === "after error", "server error recovery");

    content = 'export const answer: number = "incorrect";\n';
    const updated = session.updateSnapshot({ fileChanges: { changed: [file] } });
    const updatedProject = updated.getProject(configPath)!;
    const diagnostics = updatedProject.program.getSemanticDiagnostics(file);
    check(diagnostics.some((diagnostic) => diagnostic.code === 2322), "updated snapshot diagnostics");
    check(updatedProject.program.getSourceFile(file) !== root, "changed source version");
    // The original immutable snapshot must remain available after the update.
    check(project.program.getSemanticDiagnostics(file).length === 0 && project.program.getSourceFile(file) === root, "old snapshot retained");
    const unchanged = updatedProject.program.getSourceFile(empty)!;
    const successor = session.updateSnapshot();
    check(successor.getProject(configPath)!.program.getSourceFile(empty) === unchanged, "live latest cache retained for successor");
    snapshot.dispose();
    updated.dispose();
    successor.dispose();
    const fetchedBefore = session.getTimingInfo().totals.sourceFilesFetched;
    const retained = session.updateSnapshot();
    const refreshed = retained.getProject(configPath)!.program.getSourceFile(empty)!;
    check(refreshed.text === unchanged.text, "disposed latest source reloaded");
    check(session.getTimingInfo().totals.sourceFilesFetched === fetchedBefore + 1, "disposed latest cache revalidated against server");
    retained.dispose();
    content = "export const replacement = true;\n";
    const replaced = session.updateSnapshot({ fileChanges: { changed: [file] } });
    check(replaced.getProject(configPath)!.program.getSourceFile(file)!.text === content, "disposed latest cannot lend a stale changed source");
    check(root.text !== content, "original snapshot source remains immutable");
    replaced.dispose();
    checkCheckerSnapshots(session, client, directory);
    check(session.getTimingInfo().totals.sourceFilesFetched > 0, "native session source timing");
    const timing = client.timing();
    check(timing.requests > 20 && timing.callbacks > 0 && reads > 0, "requests and filesystem callbacks executed");
    writeFileSync(report, JSON.stringify({
      typeText, symbol: symbolName(ownedSymbol), diagnostics: diagnostics.map((diagnostic) => diagnostic.code),
      surrogateBoundary: checkSurrogateBoundary(),
      semanticSurrogateBoundary: checkSemanticSurrogateBoundary(), semanticModel: true, sessionLifecycle: true,
      echo: true, binaryAst: true, astIdentity: true, astViews: true, checkerFacade: true, checkerSnapshots: true, virtualFiles: true, retainedSnapshot: true, serverErrorRecovery: true, protocolFailures: true,
    }));
  } finally {
    session.close();
  }
}
