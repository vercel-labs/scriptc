/* The frontend's ts.* surface uses scriptc's concrete native AST, semantic
 * objects and session lifecycle over the pinned TypeScript 7 protocol. It
 * Lowering modules use a namespace import to retain both values and types:
 *
 *     import * as ts from "./ts7/adapter.js";   // path per file
 *
 * This preserves familiar `ts.name` spellings for guards, enums, helpers,
 * Ts7Host, Expression, Node, Symbol, and the other frontend types.
 *
 * Parser/checker services are injected by the client. Node convenience
 * constructors live in program-adapter.ts and are never re-exported here.
 * Syntax helpers use the native source parser; remaining TypeScript 5
 * transforms accept source strings and return world-neutral results.
 * scripts/test-ts7.mjs owns their exact import allowlist and world-check.ts
 * prevents their ASTs from entering this frontend.
 *
 * APIs replaced by dedicated services:
 *   - ts.transpileModule — the comptime evaluator runs TypeScript 7's
 *     command line (comptime.ts).
 *   - ts.resolveModuleName / ts.resolveTypeReferenceDirective — replaced by
 *     resolve.ts, the one resolver shared by the TypeScript 7 program graph
 *     and lowering.
 *   - ts.readConfigFile / ts.parseJsonConfigFileContent — replaced by
 *     Ts7Host.parseConfigFile (tsgo's own config parser, extends resolved
 *     server-side).
 *   - checker.getAwaitedType — shimmed on CheckerFacade (see checker.ts).
 * (`ts.Types` in the census tsv is a comment-text artifact, not an API.) */

export * from "./enums.js";
export * from "./ast.js";
export * from "./checker.js";
export * from "./program-host.js";

/* 5.9.3-name aliases for the program/checker surface. */
export type { CheckerFacade as TypeChecker } from "./checker.js";
export type { Ts7Program as Program } from "./program-host.js";

export * from "./semantic-types.js";

/* No default export, deliberately: ESM cannot hang the TYPE side of the
 * census (ts.Expression, ts.Node, ...) off a default binding, so a default
 * would invite the one import form that loses the types without an error. The port
 * swap is the namespace import above — same one-line change per file. */
