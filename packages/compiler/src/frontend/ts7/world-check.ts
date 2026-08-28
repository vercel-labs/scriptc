/* Two-world separation, enforced at build time. The 5.9.3 world (the
 * "typescript5" aliased import — parser/transpile islands only) and the
 * 7.0.2 world (this adapter, over the real "typescript" dependency) must
 * never exchange AST or checker objects: the enums
 * renumbered between worlds, so a node that crosses carries kinds and flags
 * that MEAN something else on the other side, silently.
 *
 * The fence is nominal enum typing: every node interface carries a
 * `kind`/`flags` member typed by its own package's enum declaration, and
 * TypeScript never treats two distinct enum declarations as assignable. The
 * assertions below pin that this actually holds in both directions for the
 * shapes that travel (nodes, source files, enum values) — if a future
 * package update ever made the worlds structurally compatible, pnpm build
 * fails HERE instead of letting objects drift across.
 *
 * Type-level only: the "typescript5" import is type-position, so no 5.9.3
 * runtime joins the adapter's module graph, and the assertion function is
 * never called. */

import type ts5 from "typescript5";
import type * as ts7 from "./adapter.js";

function assertWorldsAreDisjoint(
  node5: ts5.Node,
  node7: ts7.Node,
  file5: ts5.SourceFile,
  file7: ts7.SourceFile,
  kind5: ts5.SyntaxKind,
  kind7: ts7.SyntaxKind,
): void {
  // @ts-expect-error a 5.9.3 node must not flow into the 7 world
  const _a: ts7.Node = node5;
  // @ts-expect-error a 7 node must not flow into the 5.9.3 world
  const _b: ts5.Node = node7;
  // @ts-expect-error a 5.9.3 source file must not flow into the 7 world
  const _c: ts7.SourceFile = file5;
  // @ts-expect-error a 7 source file must not flow into the 5.9.3 world
  const _d: ts5.SourceFile = file7;
  // @ts-expect-error 5.9.3 SyntaxKind values are not 7 SyntaxKind values (renumbered)
  const _e: ts7.SyntaxKind = kind5;
  // @ts-expect-error 7 SyntaxKind values are not 5.9.3 SyntaxKind values (renumbered)
  const _f: ts5.SyntaxKind = kind7;
  void [_a, _b, _c, _d, _e, _f];
}

void assertWorldsAreDisjoint;
