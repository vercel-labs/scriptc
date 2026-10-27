/* The general stream representation (TypeMapperCtx.generalNodeStreams).
 *
 * NodeJS.ReadableStream and NodeJS.WritableStream (and @types/node's
 * stream.Readable / stream.Writable, which also type child stdio) name the
 * interface every Node stream implements. By default they map to the
 * child/process stdio handles: the specialized representation of the
 * values that commonly fill them (child.stdout, process.stdout). A program
 * that moves another stream — fs.createReadStream(), a zlib Transform, a
 * Readable subclass — into one of those slots needs the general
 * representation instead: the runtime stream classes, with the stdio
 * handles converted into them where they are read or flow.
 *
 * The decision is per program. Reachable emit lowers without it; a flow
 * that needs it marks the lowerer (needsGeneralNodeStreams) and lowerToIr
 * lowers the whole program again with it. Programs without such a flow
 * never take the second pass, so their IR is unchanged. */
import type { IrExpr, IrType } from "../../ir/ir.js";
import { everyTypeChild } from "../../ir/traverse.js";
import * as ts from "../ts7/adapter.js";
import { isGeneralNodeStreamInterface } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { streamSidesOf } from "./lower-stream.js";

const STDIO_STREAM_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "childStream",
  "childWriter",
  "procStream",
]);

/** Whether `type` (through union arms, record fields and the structural
 * type children) contains a part satisfying `test`. */
function containsPart(lowerer: Lowerer, type: IrType, test: (part: IrType) => boolean): boolean {
  const seen = new Set<string>();
  const walk = (part: IrType): boolean => {
    if (test(part)) return true;
    if (part.kind === "union") {
      if (seen.has(`u:${part.unionId}`)) return false;
      seen.add(`u:${part.unionId}`);
      return (lowerer.unions.get(part.unionId)?.arms ?? []).some(walk);
    }
    if (part.kind === "record") {
      if (seen.has(`r:${part.shapeId}`)) return false;
      seen.add(`r:${part.shapeId}`);
      return (lowerer.shapes.get(part.shapeId)?.fields ?? []).some((f) => walk(f.type));
    }
    let found = false;
    everyTypeChild(part, (child) => {
      found = walk(child);
      return !found;
    });
    return found;
  };
  return walk(type);
}

function isGeneralStream(lowerer: Lowerer, part: IrType): boolean {
  return (
    part.kind === "object" && streamSidesOf(lowerer, lowerer.classes.get(part.className)) !== null
  );
}

/** A mismatched flow (requireExactShape's input) that the general stream
 * representation resolves: a general stream into a stdio-represented
 * slot, a child pipe handle into an 'unknown' slot, or an 'unknown' value
 * into a child-pipe slot (the general classes take a checked cast). */
export function needsGeneralNodeStreams(
  lowerer: Lowerer,
  actual: IrType,
  expected: IrType,
): boolean {
  const stdio = (part: IrType): boolean => STDIO_STREAM_KINDS.has(part.kind);
  const pipeHandle = (part: IrType): boolean =>
    part.kind === "childStream" || part.kind === "childWriter";
  if (actual.kind === "dyn") return containsPart(lowerer, expected, pipeHandle);
  if (containsPart(lowerer, expected, stdio))
    return containsPart(lowerer, actual, (p) => isGeneralStream(lowerer, p));
  return expected.kind === "dyn" && containsPart(lowerer, actual, pipeHandle);
}

/** Under the general representation, process.stdout / process.stderr (the
 * procStream fd scalar) flowing into a runtime Writable slot: an
 * fd-backed Writable whose writes take the same synchronous path as
 * process.stdout.write. Null when the flow is not that one. */
export function stdioIntoGeneralStream(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType,
): IrExpr | null {
  if (!lowerer.generalNodeStreams || expr.type.kind !== "procStream") return null;
  const writable: IrType = { kind: "object", className: "%Writable" };
  // Checked-dynamic stream slots (dyn-streams.ts) hold the Writable boxed.
  const accepts =
    (expected.kind === "object" && expected.className === "%Writable") ||
    (expected.kind === "union" && lowerer.armTag(expected.unionId, writable) >= 0) ||
    (expected.kind === "dyn" && lowerer.dynNodeStreams);
  if (!accepts) return null;
  return {
    kind: "libCall",
    fn: "stream.stdioWritable",
    args: [expr],
    type: writable,
    loc: expr.loc,
  };
}

/** A stdio-handle receiver whose member has no lowering on the handle
 * (`out.on("error", ...)`, `child.stdout.pipe(...)`, `output.end()`): when
 * its declared type is one the general representation maps to a runtime
 * stream class, the program lowers again with it, where the full stream
 * surface applies. The caller still reports its fence for this pass. */
export function requestGeneralStreamSurface(lowerer: Lowerer, receiver: ts.Expression): void {
  if (lowerer.generalNodeStreams) return;
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(receiver));
  if (isGeneralNodeStreamInterface(type, lowerer.typeCtx))
    lowerer.requiresGeneralNodeStreams = true;
}

/** Under the general representation, an untyped value reaching a runtime
 * stream class slot (the checked unwrap) or an untyped pipe/pipeline
 * stage: the program lowers again with checked-dynamic stream slots
 * (dyn-streams.ts), where NodeJS.ReadableStream / NodeJS.WritableStream
 * hold JavaScript stream objects too. */
export function noteUntypedStreamFlow(lowerer: Lowerer, expected: IrType | null): void {
  if (lowerer.dynNodeStreams) return;
  if (!lowerer.generalNodeStreams) {
    // An untyped pipe or pipeline stage needs both: the next pass lowers
    // with the general representation and checked-dynamic slots at once.
    if (expected === null) {
      lowerer.requiresGeneralNodeStreams = true;
      lowerer.requiresDynNodeStreams = true;
    }
    return;
  }
  if (expected === null || containsPart(lowerer, expected, (p) => isGeneralStream(lowerer, p)))
    lowerer.requiresDynNodeStreams = true;
}
