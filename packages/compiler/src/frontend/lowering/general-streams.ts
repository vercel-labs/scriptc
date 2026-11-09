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
  // process.stdout or process.stderr flowing into a `Writable` slot (the
  // child stdin handle until the program asks for the general
  // representation) does not ask for the general representation by itself:
  // the flow stops by name (SC1090). In Node the two names are one object
  // with one writable state. Here the converted stream and the process
  // stream name still answer apart, each without a diagnostic: a write
  // through process.stdout after stream.end() or stream.destroy() is
  // written, the stream stays ended and destroyed where Node's stdio stream
  // is writable again, stream.setDefaultEncoding is not seen by
  // process.stdout.write, and a reader that closed early is not an error on
  // the stream. Until they answer as one, only a program that asks for the
  // general representation by another member reaches the conversion.
  if (containsPart(lowerer, expected, stdio))
    return containsPart(lowerer, actual, (p) => isGeneralStream(lowerer, p));
  // A child pipe handle flowing into a runtime stream slot (a declared
  // `Readable`/`Writable` variable, a parameter of one): the general
  // representation converts the handle into the runtime stream.
  if (containsPart(lowerer, expected, (p) => isGeneralStream(lowerer, p)))
    return containsPart(lowerer, actual, pipeHandle);
  return expected.kind === "dyn" && containsPart(lowerer, actual, pipeHandle);
}

const READABLE: IrType = { kind: "object", className: "%Readable" };

/** Whether `expr` reads process.stdin as a value (the process.stdio libCall
 * for descriptor 0, which answers the process stream handle). */
function readsProcessStdin(expr: IrExpr): boolean {
  const fd = expr.kind === "libCall" && expr.fn === "process.stdio" ? expr.args[0] : undefined;
  return fd?.kind === "numLit" && fd.value === 0;
}

/** A process stream as the runtime stream class `expected` names, where
 * Node's process stream is an instance of that class: process.stdout and
 * process.stderr as a Writable. The handle answers its one stream
 * (scr_stream_stdio_writable), so every conversion is the same object.
 * Null for any other pair.
 *
 * process.stdin as a Readable (stream.stdioReadable, scr_stream_stdin.c)
 * is withheld. In Node the two names are one object with one readable
 * state. Here the stream and the process.stdin name still answer apart
 * for readableLength, for destroyed after process.stdin.destroy(), and
 * for input held before the conversion, each without a diagnostic. Until
 * they answer as one, the conversion is not made and the value stops at
 * the Readable slot by name (TypeError: expected Readable, got
 * ProcessStream), as it did before the conversion existed. */
export function processStreamAs(expr: IrExpr, expected: IrType): IrExpr | null {
  if (expected.kind !== "object") return null;
  if (expected.className === "%Writable" && expr.type.kind === "procStream")
    return {
      kind: "libCall",
      fn: "stream.stdioWritable",
      args: [expr],
      type: expected,
      loc: expr.loc,
    };
  return null;
}

/** A process stream flowing into a runtime stream slot. process.stdin (the
 * process stream handle) into a Readable slot is the stdin stream, once
 * processStreamAs makes that conversion again (it answers null now). Under
 * the general representation, process.stdout / process.stderr (the
 * procStream fd scalar) into a runtime Writable slot is an fd-backed
 * Writable whose writes take the same synchronous path as
 * process.stdout.write. Null when the flow is neither. */
export function stdioIntoGeneralStream(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType,
): IrExpr | null {
  if (readsProcessStdin(expr)) {
    if (expected.kind === "object") return processStreamAs(expr, expected);
    if (expected.kind === "union" && lowerer.armTag(expected.unionId, READABLE) >= 0)
      return processStreamAs(expr, READABLE);
    return null;
  }
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
