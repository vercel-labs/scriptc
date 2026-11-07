/** One string per text among the long string literals of a pass's lowered functions.
 *
 * Lowering writes a failure message at every site that can fail: a checked narrowing, a union
 * conversion, a foreign element read. The message spells the types involved, so it is long, it is
 * built by concatenation, and a program has few distinct ones. Left alone, each site keeps its
 * own unflattened concatenation until something hashes it. The compiler's own program has 87,000
 * such literals of about 2,900 characters with 434 distinct texts: 1.85 GB by the end of a pass,
 * more than the rest of the lowered program, and 250 MB once flattened. Interned as each function
 * is finished they are 434 strings. */
import type { IrFunction } from "../../ir/ir.js";
import { everyStmtList, type IrVisitor } from "../../ir/traverse.js";

/** A literal shorter than this is left as it is: short texts are cheap, and most are distinct. */
const MIN_LENGTH = 64;

export class LiteralTexts {
  private readonly texts = new Map<string, string>();
  /** How many functions of each growing list have been interned. */
  private readonly interned = new Map<readonly IrFunction[], number>();
  private readonly visitor: IrVisitor = {
    expr: (expr) => {
      if (expr.kind === "strLit" && expr.value.length >= MIN_LENGTH) {
        const known = this.texts.get(expr.value);
        if (known === undefined) this.texts.set(expr.value, expr.value);
        else expr.value = known;
      }
      return true;
    },
    stmt: () => true,
  };

  /** Interns the string literals of one finished function. */
  intern(fn: IrFunction): void {
    everyStmtList(fn.body, this.visitor);
  }

  /** Interns the functions appended to `list` since the last call with it. */
  internAdded(list: readonly IrFunction[]): void {
    let next = this.interned.get(list) ?? 0;
    for (; next < list.length; next++) this.intern(list[next]!);
    this.interned.set(list, next);
  }
}
