/* The class-case switch of a generated class table: `switch
 * (dyn.classCase(receiver, table)) { case n: ... }`, which the lowering
 * builds over a run of capsule branches (frontend/lowering/
 * class-dynamic-dispatch.ts, caseBranchRuns). The table is a string literal
 * of `<case> <key>` lines, one per class: the selector answers the case of
 * the class whose exact key test (`dyn.typedRefIs`) the receiver passes, and
 * 0, which no case holds, for any other value. */
import { BOOL, STRING, type IrStmt } from "./ir.js";

/** A class-case table's entries, in table order. */
export function classCaseEntries(table: string): { caseNumber: number; key: string }[] {
  return table.split("\n").map((line) => {
    const space = line.indexOf(" ");
    return { caseNumber: Number(line.slice(0, space)), key: line.slice(space + 1) };
  });
}

/** Whether `stmt` is a class-case switch. */
export function isClassCaseDispatch(stmt: IrStmt): boolean {
  return stmt.kind === "switch" && stmt.disc.kind === "libCall" && stmt.disc.fn === "dyn.classCase";
}

/** The branches a class-case switch selects among, as the chain they were
 * lowered from: one `if (dyn.typedRefIs(receiver, key)) <case>` per class of
 * its table, in table order, each with the statements of its case without
 * the block and the closing `break` that wrap them (a case several classes share appears once per
 * class). A reader of a table's branches treats them as that chain. */
export function classCaseBranches(stmt: IrStmt): IrStmt[] {
  if (stmt.kind !== "switch" || stmt.disc.kind !== "libCall") return [stmt];
  const disc = stmt.disc;
  const receiver = disc.args[0]!;
  const table = disc.args[1]!;
  if (table.kind !== "strLit") return [stmt];
  const bodies = new Map<number, IrStmt[]>();
  for (const { test, body } of stmt.cases)
    if (test?.kind === "numLit")
      bodies.set(
        test.value,
        body.flatMap((branch) =>
          branch.kind === "break" ? [] : branch.kind === "block" ? branch.body : [branch],
        ),
      );
  return classCaseEntries(table.value).map(({ caseNumber, key }) => ({
    kind: "if",
    cond: {
      kind: "libCall",
      fn: "dyn.typedRefIs",
      args: [receiver, { kind: "strLit", value: key, type: STRING, loc: stmt.loc }],
      type: BOOL,
      loc: stmt.loc,
    },
    then: bodies.get(caseNumber) ?? [],
    else_: null,
    loc: stmt.loc,
  }));
}
