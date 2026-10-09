import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { f64Lit } from "./common.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

type SwitchCase = Extract<IrStmt, { kind: "switch" }>["cases"][number];

function integerLiteral(expr: IrExpr): number | null {
  if (expr.kind === "numLit") return Number.isSafeInteger(expr.value) ? expr.value : null;
  if (expr.kind === "unary" && expr.op === "-") {
    const value = integerLiteral(expr.operand);
    return value === null ? null : -value;
  }
  return null;
}

function emitIntegerSwitch(
  host: LlvmEmitterContext,
  disc: LlValue,
  cases: readonly SwitchCase[],
  labels: readonly string[],
  fallback: string,
): boolean {
  const targets = new Map<number, string>();
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index]!.test;
    if (test === null) continue;
    const value = integerLiteral(test);
    if (value === null) return false;
    // Strict equality chooses the first matching case, including -0/0.
    if (!targets.has(value)) targets.set(value, labels[index]!);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (targets.size < 4) return false;

  const B = host.B;
  const unsigned = min >= 0 && max > 2147483647 && max <= 4294967295;
  const bits = unsigned || (min >= -2147483648 && max <= 2147483647) ? "i32" : "i64";
  const low = B.tmp();
  const high = B.tmp();
  const inside = B.tmp();
  const convert = B.newLabel("sw.convert");
  const dispatch = B.newLabel("sw.integer");
  B.line(`${low} = fcmp oge double ${disc.name}, ${f64Lit(min)}`);
  B.line(`${high} = fcmp ole double ${disc.name}, ${f64Lit(max)}`);
  B.line(`${inside} = and i1 ${low}, ${high}`);
  B.condBr(inside, convert, fallback);
  B.startBlock(convert);
  const integer = B.tmp();
  const restored = B.tmp();
  const exact = B.tmp();
  // Ordered range checks dominate conversion: NaN and out-of-range values
  // must not produce poison. The round trip rejects fractional inputs.
  B.line(`${integer} = ${unsigned ? "fptoui" : "fptosi"} double ${disc.name} to ${bits}`);
  B.line(`${restored} = ${unsigned ? "uitofp" : "sitofp"} ${bits} ${integer} to double`);
  B.line(`${exact} = fcmp oeq double ${disc.name}, ${restored}`);
  B.condBr(exact, dispatch, fallback);
  B.startBlock(dispatch);
  B.terminate(
    `switch ${bits} ${integer}, label %${fallback} [ ${[...targets]
      .map(([value, label]) => `${bits} ${value}, label %${label}`)
      .join(" ")} ]`,
  );
  return true;
}

function emitStringSwitch(
  host: LlvmEmitterContext,
  disc: LlValue,
  cases: readonly SwitchCase[],
  labels: readonly string[],
  fallback: string,
): boolean {
  const groups = new Map<number, { value: string; label: string }[]>();
  const seen = new Set<string>();
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index]!.test;
    if (test === null) continue;
    if (test.kind !== "strLit") return false;
    if (seen.has(test.value)) continue;
    seen.add(test.value);
    const length = Buffer.byteLength(test.value, "utf8");
    let group = groups.get(length);
    if (group === undefined) groups.set(length, (group = []));
    group.push({ value: test.value, label: labels[index]! });
  }
  if (seen.size < 4 || groups.size < 2) return false;

  const B = host.B;
  const pointer = B.tmp();
  const length = B.tmp();
  B.line(`${pointer} = getelementptr inbounds ${host.sizeType}, ptr ${disc.name}, i32 1`);
  B.line(`${length} = load ${host.sizeType}, ptr ${pointer}`);
  const groupLabels = new Map<number, string>();
  for (const size of groups.keys()) groupLabels.set(size, B.newLabel("sw.length"));
  B.terminate(
    `switch ${host.sizeType} ${length}, label %${fallback} [ ${[...groupLabels]
      .map(([size, label]) => `${host.sizeType} ${size}, label %${label}`)
      .join(" ")} ]`,
  );
  host.declare("declare zeroext i1 @scr_str_eq(ptr, ptr)");
  for (const [size, group] of groups) {
    B.startBlock(groupLabels.get(size)!);
    for (let index = 0; index < group.length; index++) {
      const item = group[index]!;
      const literal = host.internLiteral(item.value);
      const hit = B.tmp();
      const next = index + 1 < group.length ? B.newLabel("sw.equal") : fallback;
      B.line(`${hit} = call zeroext i1 @sc_str_eq(ptr ${disc.name}, ptr ${literal})`);
      B.condBr(hit, item.label, next);
      if (next !== fallback) B.startBlock(next);
    }
  }
  return true;
}

/** Only literal cases can reorder their comparisons. Bodies still use the
 * emitter's shared scope, cleanup, default placement and fallthrough. */
export function emitLiteralSwitch(
  host: LlvmEmitterContext,
  disc: LlValue,
  cases: readonly SwitchCase[],
  labels: readonly string[],
  fallback: string,
): boolean {
  if (disc.type.kind === "f64") return emitIntegerSwitch(host, disc, cases, labels, fallback);
  if (disc.type.kind === "string") return emitStringSwitch(host, disc, cases, labels, fallback);
  return false;
}
