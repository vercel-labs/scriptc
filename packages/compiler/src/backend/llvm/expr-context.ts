/* Internal type-only boundary between the LLVM emitter core and its
 * extracted expression/library emission modules. Runtime ownership stays
 * with LlEmitter; helpers receive this structural view at delegation. */
import type { IrBytesElem, IrExpr, IrFfiImport, IrFunction, IrLibFn, IrLocal, IrModule, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import type { FfiCallbackAdapter } from "../ffi-callbacks.js";
import type { BlockBuilder } from "./blocks.js";
import type { LlClassMeta } from "./classes.js";
import type { LlDyn } from "./dyn.js";
import type { ShapeHost } from "./shapes.js";
import type { LlWalkers } from "./walkers.js";

export interface LlValue {
  name: string;
  type: IrType;
  slot?: boolean;
}

export type ExprOf<K extends IrExpr["kind"]> = Extract<IrExpr, { kind: K }>;
export type LibCallExpr = ExprOf<"libCall">;
type LibCallPrefixOf<T extends string> = T extends `${infer Prefix}.${string}` ? Prefix : never;
export type LibCallPrefix = LibCallPrefixOf<IrLibFn>;

export interface LlStreamTypedRefAdapter {
  snapshot: string;
  commit: string;
}

export interface LlStreamTypedRefContext {
  prefix: string;
  adapters: Map<string, LlStreamTypedRefAdapter>;
}

export interface PromiseAllTupleThunks {
  store: string;
  finish: string;
  drop: string;
}

export interface LlvmEmitterContext extends ShapeHost {
  B: BlockBuilder;
  abiOffset(native64: number, wasm32: number): number;
  arrPush(arr: string, acc: "f64" | "bool" | "ref", value: string): string;
  binding(id: string): { kind: "global" | "local" | "boxed"; slot: string; type: IrType; local?: IrLocal };
  boxGet(box: string, t: IrType): string;
  boxSet(box: string, t: IrType, value: string): void;
  callTarget(fnName: string): string;
  chainSlots: Map<string, LlValue>;
  childDataThunkFor(param: IrType): string;
  childExitSignalThunkFor(codeParam: IrType, sigParam: IrType): string;
  childExitThunkFor(param: IrType): string;
  classFieldPtr(objName: string, className: string, field: string): { ptr: string; type: IrType };
  classMeta: Map<string, LlClassMeta>;
  classMetaOf(className: string): LlClassMeta;
  classObjSym(className: string): string;
  closeBindThunkFor(cbUnion: IrType, retServer: boolean): string;
  closeOverrideWrapFor(cbUnion: IrType, retServer: boolean): string;
  cstr(text: string): string;
  currentGenerator: { yieldT: IrType; nextT: IrType; } | null;
  currentWasiCoro: { kind: "async" | "generator"; id: string; handle: string; self: string; finalLabel: string; cleanupLabel: string; suspendLabel: string; } | null;
  declare(decl: string): void;
  dyn: LlDyn;
  dynKind(d: string): string;
  dynPromiseAdapter(inner: IrType): string;
  dynPromiseAdapters: Map<string, string>;
  emitArrIntrinsic(e: IrExpr & { kind: "arrIntrinsic" }): LlValue;
  emitArrayCopyLoop(dst: string, src: string, acc: "f64" | "bool" | "ref"): void;
  emitAssertInspectLibCall(e: LibCallExpr): LlValue;
  emitAsyncContextLibCall(e: LibCallExpr): LlValue;
  emitAsyncExpr(e: ExprOf<"yieldExpr" | "genResume" | "awaitExpr" | "awaitUnionExpr" | "newPromise" | "promiseWithResolvers">): LlValue;
  emitBranchInto(slot: string, expr: IrExpr): void;
  emitBytesData(receiver: string): string;
  emitBytesGet(elem: IrBytesElem, receiver: string, index: string, integerIndex?: boolean): LlValue;
  emitBytesIndex(receiver: string, index: string, integerIndex?: boolean): string;
  emitBytesIntrinsic(e: IrExpr & { kind: "bytesIntrinsic" }): LlValue;
  emitBytesLength(elem: IrBytesElem, receiver: string, bytes: boolean): LlValue;
  emitBytesReceiver(receiver: IrExpr, following: IrExpr[]): LlValue;
  emitBytesU32(value: string): string;
  emitCallExpr(e: ExprOf<"call" | "ffiCall" | "closure" | "callValue" | "selfRef" | "new" | "classRef" | "newValue" | "instanceOfValue" | "promiseVoidWiden" | "upcast" | "downcast" | "instanceOf" | "virtualCall">): LlValue;
  emitChildProcessLibCall(e: LibCallExpr): LlValue;
  emitContainerExpr(e: ExprOf<"arrayLit" | "arrayNewLen" | "arrayGet" | "arrIntrinsic" | "bytesNew" | "bytesIntrinsic" | "mapNew" | "mapIntrinsic" | "setIntrinsic" | "setNew">): LlValue;
  emitControlExpr(e: ExprOf<"dynDestrCheck" | "dynIterN" | "toBool" | "logical" | "ternary" | "optChain" | "chainRecv" | "orDefault" | "nullish">): LlValue;
  emitDynamicExpr(e: ExprOf<"dynFrom" | "dynFromJsval" | "dynCall" | "dynInvoke" | "dynArrLit" | "dynObjLit" | "unionWrap" | "unionNarrow" | "unionDisc" | "unionKeyGet" | "unionIsTag" | "dynKeyGet" | "dynHasKey" | "dynScalarEq" | "dynTest" | "unionEq" | "unionFuncEq" | "caughtTest" | "caughtCheck" | "caughtNarrow" | "caughtToDyn">): LlValue;
  emitDynamicLibCall(e: LibCallExpr): LlValue;
  emitErrorsEventsLibCall(e: LibCallExpr): LlValue;
  emitExpr(e: IrExpr): LlValue;
  emitFilesystemLibCall(e: LibCallExpr): LlValue;
  emitGenericLibCall(e: LibCallExpr): LlValue;
  emitIntegerLoopIndex(expr: IrExpr): string | null;
  emitIntrinsicExpr(e: ExprOf<"intrinsic">): LlValue;
  emitIoLibCall(e: LibCallExpr): LlValue;
  emitJsExit(e: IrExpr & { kind: "jsExit" }): LlValue;
  emitJsInteropExpr(e: ExprOf<"jsMarshal" | "jsOp" | "jsExit" | "jsBridgePromise">): LlValue;
  emitJsMarshal(e: IrExpr & { kind: "jsMarshal" }): LlValue;
  emitJsOp(e: IrExpr & { kind: "jsOp" }): LlValue;
  emitLibCall(e: LibCallExpr): LlValue;
  emitLiteralExpr(e: ExprOf<"numLit" | "boolLit" | "strLit" | "unitLit" | "varRef">): LlValue;
  emitMapLikeIntrinsic(e: Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }>): LlValue;
  emitMapNew(e: IrExpr & { kind: "mapNew" }): LlValue;
  emitNetworkHttpLibCall(e: LibCallExpr): LlValue;
  emitOperatorExpr(e: ExprOf<"bin" | "unary" | "incDec" | "fieldIncDec" | "assignExpr" | "seqExpr">): LlValue;
  emitPathUrlLibCall(e: LibCallExpr): LlValue;
  emitPendingCheck(): void;
  emitPrimitiveLibCall(e: LibCallExpr): LlValue;
  emitProcessLibCall(e: LibCallExpr): LlValue;
  emitRecordExpr(e: ExprOf<"fieldGet" | "recordGet" | "recordLit" | "recordClone" | "recordKeyGet" | "recordOvfKeys">): LlValue;
  emitRecordKeyGet(e: IrExpr & { kind: "recordKeyGet" }): LlValue;
  emitRegexIntrinsic(e: IrExpr & { kind: "regexIntrinsic" }): LlValue;
  emitSerializationExpr(e: ExprOf<"jsonStringify" | "dynCheck">): LlValue;
  emitSetNew(e: IrExpr & { kind: "setNew" }): LlValue;
  emitStmt(s: IrStmt): void;
  emitStrIntrinsic(e: IrExpr & { kind: "strIntrinsic" }): LlValue;
  emitStreamLibCall(e: LibCallExpr): LlValue;
  emitStringExpr(e: ExprOf<"strConcat" | "strEq" | "strCmp" | "toString" | "strIntrinsic" | "regexLit" | "templateStrings" | "regexIntrinsic">): LlValue;
  emitStringSelfConcatAssign(localId: string, left: IrExpr, suffix: IrExpr, retainForYield: boolean): LlValue;
  emitThrowValue(v: LlValue): void;
  emitWasiSuspend(promise: string | null): void;
  emitWasiSuspendPrepared(): void;
  emitWebLibCall(e: LibCallExpr): LlValue;
  emitterFixedAdapter(cbT: IrType & { kind: "func" }): { fn: string; shim: string };
  ffiByName: Map<string, IrFfiImport>;
  ffiCallbackAdapter(binding: string, id: string): FfiCallbackAdapter;
  ffiHasRetainedCallback: boolean;
  fnByName: Map<string, IrFunction>;
  fnValues: Set<string>;
  frames: LlValue[][];
  fsRenameThunkFor(cbT: IrType & { kind: "func" }): string;
  genResultThunkFor(genT: IrType & { kind: "generator" }, recT: IrType & { kind: "record" }): string;
  indirectMayThrow: boolean;
  integerLoopBindings: Map<string, string>;
  internLiteral(text: string): string;
  islandAdapter(arity: number, retKind: "void" | "jsval" | "f64" | "bool" | "string"): string;
  islandTypedAdapter(fn: IrType & { kind: "func" }): string;
  keyedRecordReadInto(slot: string, join: string, objName: string, keyName: string, shapeId: string, resultType: IrType, overflowOnly: boolean, loc?: SrcLoc): void;
  liveDynRefAdapters: Map<string, LlStreamTypedRefAdapter>;
  liveDynUnionRefAdapter(t: IrType & { kind: "union" }): string;
  liveDynUnionRefAdapters: Map<string, string>;
  llType(t: IrType): string;
  loadBox(slot: string): string;
  loadField(ptr: string, t: IrType): string;
  loadVtPre(objName: string, staticClassName: string): string;
  logArgSlots: number;
  mapSet(m: string, kAcc: "f64" | "str" | "ref", vAcc: "f64" | "bool" | "ref", key: string, value: string): void;
  mayThrow: Set<string>;
  mayThrowMethods: Set<string>;
  mod: IrModule;
  moveTemp(v: LlValue): void;
  needsBadKey: boolean;
  needsBadTag: boolean;
  own(v: LlValue): LlValue;
  ownSlot(slot: string, type: IrType): void;
  promiseAllTupleFor(tupleT: IrType & { kind: "record" }): PromiseAllTupleThunks;
  promiseAllTupleThunks: Map<string, PromiseAllTupleThunks>;
  raceAdapterFor(from: IrType, to: IrType): string;
  recordCloneShapes: Set<string>;
  recordFieldPtr(objName: string, shapeId: string, field: string): { ptr: string; type: IrType };
  recordOvfPtr(objName: string, shapeId: string): string;
  recordShape(shapeId: string): IrRecordShape;
  recordsById: Map<string, IrRecordShape>;
  regexInstances: Map<string, { sym: string; src: string; fl: string; }>;
  releaseFrame(frame: LlValue[]): void;
  releaseValue(name: string, type: IrType): void;
  resolveThunkDefs: string[];
  resolveThunkFor(inner: IrType): string;
  resolveThunks: Map<string, string>;
  retainBox(box: string): string;
  retainValue(name: string, type: IrType): string;
  sizeType: "i32" | "i64";
  storeField(ptr: string, t: IrType, value: string): void;
  streamCbThunkFor(kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string;
  streamDataAdapter(cbT: IrType & { kind: "func" }): string;
  streamDoneFnFor(kind: "w" | "f" | "d" | "t" | "l", doneT: IrType & { kind: "func" }): string;
  streamFromArrayAdapter(t: IrType & { kind: "array" }): string;
  streamFromArrayAdapters: Map<string, string>;
  streamTypedRefBoxValue(B: BlockBuilder, t: IrType, value: string, ctx: LlStreamTypedRefContext): string;
  streamTypedRefCommitAdapter(t: IrType, snapshot: string): string;
  streamTypedRefMaterializeAdapter(t: IrType, ctx: LlStreamTypedRefContext, preferredSnapshot?: string): LlStreamTypedRefAdapter;
  tagInSet(uName: string, tags: number[]): string;
  tdzBoxRead(box: string, t: IrType, name: string): string;
  templateStringsInstances: Map<string, { sym: string; slots: string[]; }>;
  truthy(v: LlValue): string;
  unionExtract(uName: string, arm: IrType): string;
  unionNewOwned(tag: number, v: LlValue): string;
  unionPeek(uName: string): string;
  unionTag(uName: string): string;
  unionTagSwitch(uName: string, def: IrUnionDef, arm: (armType: IrType, tag: number) => void): void;
  unionsById: Map<string, IrUnionDef>;
  unitInstanceRef(unionId: string, tag: number): string;
  unwrapNullableClosure(u: string, funcTag: number): string;
  usesTimers: boolean;
  walkers: LlWalkers;
  wasi: boolean;
  wrapEmitterListener(target: string, adapterFn: string): string;
  wrapNullable(raw: string, present: string, valueType: IrType, valueTag: number, resultType: IrType & { kind: "union" }, absentTag: number): LlValue;
}
