/* The TS7 adapter: the census's ts.* surface (the survey's top-40 table plus
 * the long tail of census-ts-members.tsv) re-exported over typescript@7.0.2's
 * unstable API, shaped so the phase-2 mechanical port swaps
 *
 *     import ts from "typescript";
 * for
 *     import * as ts from "./ts7/adapter.js";   // path per file
 *
 * per file and keeps every `ts.name` spelling — values (guards, enums,
 * helpers, createProgram) and types (ts.Expression, ts.Node, ts.Symbol, ...)
 * alike. The namespace-import form is the swap because ESM has no way to
 * hang types off a default export.
 *
 * TWO-WORLD DISCIPLINE. typescript@7.0.2 is the REAL "typescript"
 * dependency; typescript@5.9.3 stays installed under the "typescript5"
 * alias for the parser/transpile islands only (npm.ts's module edge scan
 * over node_modules JS — 7.0.2 ships no client-side parser — cjs-lexer.ts's
 * merve-port lex over CJS source text, and lower-comptime's
 * transpileModule). Nothing may hand a 5.9.3 node, type, symbol, or enum
 * value to this world or back (cjs-lexer.ts's exports take and answer
 * strings and name sets only — its 5.9.3 parse is an implementation
 * detail behind that boundary):
 *   - Mixing OBJECTS is a compile-time error: every node interface carries
 *     `kind: SyntaxKind` and the two packages declare DISTINCT enums, which
 *     TypeScript treats nominally — a 5.9.3 SourceFile is not assignable
 *     where the adapter takes one, and vice versa (world-check.ts pins this
 *     with @ts-expect-error assertions that pnpm build enforces).
 *   - Mixing ENUM VALUES cannot be fenced by the type system alone (both
 *     erase to number), which is why every enum here re-exports 7's own
 *     objects symbolically and no scriptc source may import "typescript5"
 *     outside the two island files.
 *
 * Census coverage not present here, by design (the survey's MISSING list):
 *   - ts.createSourceFile / ts.preProcessFile — no client-side parser in 7;
 *     the npm.ts edge scan keeps 5.9.3 (island).
 *   - ts.transpileModule — lower-comptime keeps 5.9.3 (island).
 *   - ts.resolveModuleName / ts.resolveTypeReferenceDirective — resolution
 *     helpers stay 5.9.3-hosted for now (they take ts.sys-shaped hosts and
 *     never exchange AST/checker objects with either world; tsgo resolves
 *     the embedded program itself, server-side).
 *   - ts.readConfigFile / ts.parseJsonConfigFileContent — replaced by
 *     Ts7Host.parseConfigFile (tsgo's own config parser, extends resolved
 *     server-side).
 *   - checker.getAwaitedType — shimmed on CheckerFacade (see checker.ts).
 * (`ts.Types` in the census tsv is a comment-text artifact, not an API.) */

export * from "./enums.js";
export * from "./ast.js";
export * from "./checker.js";
export * from "./program-adapter.js";

/* 5.9.3-name aliases for the program/checker surface. */
export type { CheckerFacade as TypeChecker } from "./checker.js";
export type { Ts7Program as Program } from "./program-adapter.js";

/* Checker-world object types under their census names. Symbol and Signature
 * are 7's client classes (identity-bearing — the registry dedupes by server
 * handle); Type and friends are the client interfaces. TupleTypeReference
 * aliases 7's TupleType: in 5.9.3 a tuple's reference and its target were
 * split, in 7 the client hands back one object playing both roles (it
 * satisfies getTypeArguments and elementFlags alike, the two things the
 * census does with it). */
export type {
  CompilerOptions,
  Diagnostic,
  IndexInfo,
  InterfaceType,
  ObjectType,
  Signature,
  Symbol,
  TupleType,
  TupleType as TupleTypeReference,
  Type,
  TypePredicate,
  TypeReference,
  UnionOrIntersectionType,
  UnionType,
} from "typescript/unstable/sync";

/* No default export, deliberately: ESM cannot hang the TYPE side of the
 * census (ts.Expression, ts.Node, ...) off a default binding, so a default
 * would invite the one import form that silently loses the types. The port
 * swap is the namespace import above — same one-line change per file. */
