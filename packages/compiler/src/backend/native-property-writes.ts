import {
  BOOL,
  F64,
  STRING,
  NATIVE_PROPERTY_OPERATION,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../ir/ir.js";
import { transformStmtList } from "../ir/traverse.js";
import { computeNativeIntegrityTypes, nativeRecordWritePredicate } from "../ir/native-integrity.js";

function hasAbsent(value: IrExpr): boolean {
  return (
    value.kind === "fieldAbsent" ||
    (value.kind === "ternary" && (hasAbsent(value.then) || hasAbsent(value.else_)))
  );
}

/** Save the complete write before admission. The successful branch owns
 * both the slot mutation and descriptor reset; a sloppy refusal still
 * evaluates the RHS but leaves the property untouched. */
export function guardNativePropertyWrites(mod: IrModule): IrModule {
  const exposed = computeNativeIntegrityTypes(mod);
  if (!exposed) return mod;
  const guarded = nativeRecordWritePredicate(mod, exposed);
  const functions = mod.functions.map((original): IrFunction => {
    const fn = { ...original, locals: [...original.locals] };
    const done = new Set<IrStmt>();
    const save = (value: IrExpr, body: IrStmt[]): IrExpr => {
      const id = `%native.write.${fn.locals.length}`;
      fn.locals.push({ id, name: id, type: value.type, mutable: false });
      body.push({ kind: "varDecl", localId: id, init: value, loc: value.loc });
      return { kind: "varRef", localId: id, type: value.type, loc: value.loc };
    };
    fn.body = transformStmtList(fn.body, {
      expr: (expr) => {
        if (expr.kind !== "seqExpr") return expr;
        // The frontend's unique-string append temporarily empties a slot.
        // A guarded write can call user code, so retain the old slot until
        // its one final admission instead of exposing that temporary state.
        const stmts = expr.stmts.filter((stmt, i, body) => {
          if (
            !guarded(stmt) ||
            stmt.kind !== "recordSet" ||
            stmt.value.kind !== "strLit" ||
            stmt.value.value !== ""
          )
            return true;
          const concat = body[i + 1],
            restore = body[i + 2];
          return !(
            concat?.kind === "assign" &&
            concat.value.kind === "strConcat" &&
            concat.value.left.kind === "varRef" &&
            concat.value.left.localId === concat.localId &&
            restore?.kind === "recordSet" &&
            restore.shapeId === stmt.shapeId &&
            restore.field === stmt.field &&
            restore.value.kind === "varRef" &&
            restore.value.localId === concat.localId &&
            stmt.obj.kind === "varRef" &&
            restore.obj.kind === "varRef" &&
            stmt.obj.localId === restore.obj.localId
          );
        });
        return stmts.length === expr.stmts.length ? expr : { ...expr, stmts };
      },
      stmt: (stmt) => {
        if (!guarded(stmt) || done.has(stmt)) return stmt;
        const body: IrStmt[] = [],
          loc = stmt.loc;
        const receiver = save(stmt.obj, body);
        const key =
          stmt.kind === "recordSet"
            ? { kind: "strLit" as const, value: stmt.field, type: STRING, loc }
            : save(stmt.key, body);
        const write = (input: IrExpr, branch: IrStmt[]): void => {
          if (input.kind === "ternary" && hasAbsent(input)) {
            const yes: IrStmt[] = [],
              no: IrStmt[] = [];
            const cond = save(input.cond, branch);
            write(input.then, yes);
            write(input.else_, no);
            branch.push({
              kind: "if",
              cond,
              // oxlint-disable-next-line unicorn/no-thenable -- An IR branch contains statements.
              then: yes,
              else_: no,
              loc,
            });
            return;
          }
          const requested = stmt.propertyOp ?? "set";
          // An internal ABSENT leaf clears ownership; unlike undefined it
          // follows deletion policy and never becomes a setter argument.
          const operation =
            input.kind === "fieldAbsent" && (requested === "set" || requested === "setSloppy")
              ? requested === "setSloppy"
                ? "deleteSloppy"
                : "delete"
              : requested;
          const deleting = operation === "delete" || operation === "deleteSloppy";
          // ABSENT belongs only in a property slot, never a lexical local.
          const value = input.kind === "fieldAbsent" ? input : save(input, branch);
          // Construct a canonical statement arm before using its identity as
          // a key. A spread with an optional key creates a different shape.
          const store: IrStmt =
            stmt.kind === "recordSet"
              ? { ...stmt, obj: receiver, propertyOp: operation, value }
              : { ...stmt, obj: receiver, propertyOp: operation, key, value };
          done.add(store);
          const success: IrStmt[] = [store];
          // The store owner finalizes metadata before releasing its old child.
          // A trailing expression here would run after that observable release.
          const admission: IrStmt = {
            kind: "if",
            cond: {
              kind: "intrinsic",
              name: "native.checkWrite",
              args: [
                receiver,
                key,
                { kind: "numLit", value: NATIVE_PROPERTY_OPERATION[operation], type: F64, loc },
                ...(operation === "set" || operation === "setSloppy" ? [value] : []),
              ],
              type: BOOL,
              loc,
            },
            // oxlint-disable-next-line unicorn/no-thenable -- An IR branch is a statement array, never a callable.
            then: success,
            else_: null,
            loc,
          };
          // Deleting a missing property succeeds without a physical store.
          // Published/shared records must not even rewrite the same sentinel.
          if (deleting && stmt.kind === "recordSet")
            branch.push({
              kind: "if",
              cond: {
                kind: "recordHas",
                obj: receiver,
                shapeId: stmt.shapeId,
                field: stmt.field,
                type: BOOL,
                loc,
              },
              // oxlint-disable-next-line unicorn/no-thenable -- An IR branch contains statements.
              then: [admission],
              else_: null,
              loc,
            });
          else branch.push(admission);
        };
        write(stmt.value, body);
        return { kind: "block", body, loc };
      },
    });
    return fn;
  });
  return { ...mod, functions };
}
