// Generated from packages/compiler/src/ir/ir.ts by scripts/generate-ir-codec.mjs.
// Run `pnpm generate:ir-codec` after changing the IR's types.
import type { IrBindingSource, IrClassDef, IrContracts, IrExpr, IrFfiCallbackParam, IrFfiContextParam, IrFfiImport, IrFfiParam, IrFfiReleaseParam, IrFunction, IrGlobal, IrLibCallback, IrLibExport, IrLibIdentity, IrLibSection, IrLibTrapOverlay, IrLocal, IrModule, IrNodeIslandModules, IrParam, IrRecordLink, IrRecordShape, IrStmt, IrType, IrUnionDef, IrUnionDiscriminant, IrWasmModule, IrWasmUntranslated, SrcLoc } from "./ir.js";
import type { IrReader, IrWriter } from "./codec.js";

/** A digest of the coders below: an encoding written with other coders is
 * refused instead of misread, also after a change that keeps IR_VERSION. */
export const IR_CODEC_LAYOUT = "788d21549d491627";

/** Writes `mod` field by field (codec.ts describes the bytes). */
export function encodeIrModule(w: IrWriter, mod: IrModule): void {
  encIrModule(w, mod);
}
/** Reads a module encodeIrModule wrote. */
export function decodeIrModule(r: IrReader): IrModule {
  return decIrModule(r);
}
/** Writes one function. */
export function encodeIrFunction(w: IrWriter, fn: IrFunction): void {
  encIrFunction(w, fn);
}
/** Reads a function encodeIrFunction wrote. */
export function decodeIrFunction(r: IrReader): IrFunction {
  return decIrFunction(r);
}

const KEYS0: readonly string[] = ["irVersion","sourceFile","functions","classes","globals","records","unions","entry","workers","declBoundary","inferredFactFiles","declOrigins","lifetimeRegions","foreignElementKeys","recordLinks","threadSlotKeys","freezableArrays","sloppyDynWrites","untypedIntegrity","commonJsEntry","nodeIsland","ffiImports","lib","contracts","int32ArrayCandidates","wasmModules","wasmUntranslated","wasmCustomSections"];
const KEYS1: readonly string[] = ["name","sourceName","displayName","ownsPrototype","params","returnType","locals","captures","classCaptures","body","loc","jsEntry","tier","speculativeDispatch","fastRead","plainLoops","async","generator","asyncCacheGlobal","asyncCycleCacheGlobal"];
const KEYS2: readonly string[] = ["libnode","nodeVersion","modules"];
const KEYS3: readonly string[] = ["profileName","prefix","initSymbol","sinkRegisterSymbol","collectSymbol","resultResetSymbol","threadInstances","callbackRegisterSymbol","callbacks","exports","trapOverlays","identity"];
const KEYS4: readonly string[] = ["int32Fields","int32Params","int32Returns","int32Locals","int32Elements","noThrow","acyclic","immortalGlobals","programLifetime","inlineArrays"];
const KEYS5: readonly string[] = ["kind","elem","optionalElements"];
const KEYS6: readonly string[] = ["kind"];
const KEYS7: readonly string[] = ["kind"];
const KEYS8: readonly string[] = ["kind"];
const KEYS9: readonly string[] = ["kind","elem"];
const KEYS10: readonly string[] = ["kind"];
const KEYS11: readonly string[] = ["kind"];
const KEYS12: readonly string[] = ["kind"];
const KEYS13: readonly string[] = ["kind"];
const KEYS14: readonly string[] = ["kind","className"];
const KEYS15: readonly string[] = ["kind"];
const KEYS16: readonly string[] = ["kind"];
const KEYS17: readonly string[] = ["kind"];
const KEYS18: readonly string[] = ["kind"];
const KEYS19: readonly string[] = ["kind"];
const KEYS20: readonly string[] = ["kind"];
const KEYS21: readonly string[] = ["kind"];
const KEYS22: readonly string[] = ["kind"];
const KEYS23: readonly string[] = ["kind"];
const KEYS24: readonly string[] = ["kind","params","ret","rest","restAbi","argumentsAll"];
const KEYS25: readonly string[] = ["kind","async","yieldT","retT","nextT"];
const KEYS26: readonly string[] = ["kind"];
const KEYS27: readonly string[] = ["kind"];
const KEYS28: readonly string[] = ["kind"];
const KEYS29: readonly string[] = ["kind"];
const KEYS30: readonly string[] = ["kind"];
const KEYS31: readonly string[] = ["kind"];
const KEYS32: readonly string[] = ["kind","key","value"];
const KEYS33: readonly string[] = ["kind","moduleId"];
const KEYS34: readonly string[] = ["kind"];
const KEYS35: readonly string[] = ["kind"];
const KEYS36: readonly string[] = ["kind"];
const KEYS37: readonly string[] = ["kind","className"];
const KEYS38: readonly string[] = ["kind"];
const KEYS39: readonly string[] = ["kind","inner"];
const KEYS40: readonly string[] = ["kind","shapeId"];
const KEYS41: readonly string[] = ["kind"];
const KEYS42: readonly string[] = ["kind"];
const KEYS43: readonly string[] = ["kind"];
const KEYS44: readonly string[] = ["kind","elem"];
const KEYS45: readonly string[] = ["kind"];
const KEYS46: readonly string[] = ["kind"];
const KEYS47: readonly string[] = ["kind"];
const KEYS48: readonly string[] = ["kind"];
const KEYS49: readonly string[] = ["kind"];
const KEYS50: readonly string[] = ["kind"];
const KEYS51: readonly string[] = ["kind","unionId"];
const KEYS52: readonly string[] = ["kind"];
const KEYS53: readonly string[] = ["kind"];
const KEYS54: readonly string[] = ["file","start","end"];
const KEYS55: readonly string[] = ["yieldT","nextT","resultType","closesSource","tag","inheritsTag","bindAtCall"];
const KEYS56: readonly string[] = ["name","localCaptures","localBaseCapture","baseValueGlobal","jsName","jsLength","ownStaticFields","prototypeDataHelper","instancePrototypeHelper","stringTagHelper","tracksOwnFields","errorNameAfter","errorBagOrder","symbolFields","runtime","arrayElem","arrayFields","arraySpecies","base","fields","methods","prototypeNames","abstract","abstractMethods","genericOf","loc"];
const KEYS57: readonly string[] = ["id","name","type","mutable","tdz","initFlag","source"];
const KEYS58: readonly string[] = ["id","fields","tuple","indexValue","freezable","declaredOrder","accessorOrder","orderVariants"];
const KEYS59: readonly string[] = ["id","arms","discriminant"];
const KEYS60: readonly string[] = ["file","pkg"];
const KEYS61: readonly string[] = ["pair","from","to","compose"];
const KEYS62: readonly string[] = ["root","files","links","location"];
const KEYS63: readonly string[] = ["name","symbol","library","callbackOperation","callbackTarget","params","returns"];
const KEYS64: readonly string[] = ["buildIdSymbol","abiVersionSymbol","buildId","abiVersion"];
const KEYS65: readonly string[] = ["sha256","bytes"];
const KEYS66: readonly string[] = ["sha256","size","reason"];
const KEYS67: readonly string[] = ["localId","name","type","owned"];
const KEYS68: readonly string[] = ["id","name","type","mutable","source","boxed","tdz"];
const KEYS69: readonly string[] = ["localId","name","type","owned","slot"];
const KEYS70: readonly string[] = ["kind","arr","index","loc"];
const KEYS71: readonly string[] = ["kind","arr","index","value","loc"];
const KEYS72: readonly string[] = ["kind","arr","length","loc","pop","reserve"];
const KEYS73: readonly string[] = ["kind","arr","index","loc"];
const KEYS74: readonly string[] = ["kind","localId","value","initializes","loc"];
const KEYS75: readonly string[] = ["kind","labels","body","loc"];
const KEYS76: readonly string[] = ["kind","label","loc"];
const KEYS77: readonly string[] = ["kind","arr","index","value","loc"];
const KEYS78: readonly string[] = ["kind","label","loc"];
const KEYS79: readonly string[] = ["kind","body","cond","labels","loc"];
const KEYS80: readonly string[] = ["kind","expr","loc"];
const KEYS81: readonly string[] = ["kind","obj","className","field","value","sloppy","define","attributesChecked","loc"];
const KEYS82: readonly string[] = ["kind","init","cond","update","body","labels","loc"];
const KEYS83: readonly string[] = ["kind","localId","iterable","body","labels","loc"];
const KEYS84: readonly string[] = ["kind","loc"];
const KEYS85: readonly string[] = ["kind","cond","then","else_","loc"];
const KEYS86: readonly string[] = ["kind","obj","shapeId","key","loc"];
const KEYS87: readonly string[] = ["kind","obj","shapeId","key","value","overflowOnly","loc"];
const KEYS88: readonly string[] = ["kind","obj","shapeId","field","value","loc"];
const KEYS89: readonly string[] = ["kind","localId","loc"];
const KEYS90: readonly string[] = ["kind","value","awaited","loc"];
const KEYS91: readonly string[] = ["kind","code","message","loc"];
const KEYS92: readonly string[] = ["kind","disc","cases","labels","loc"];
const KEYS93: readonly string[] = ["kind","value","loc"];
const KEYS94: readonly string[] = ["kind","tryBody","catchBody","catchLocalId","dropFinallyErrors","finallyBody","suppressFinallyErrors","loc"];
const KEYS95: readonly string[] = ["kind","localId","init","loc"];
const KEYS96: readonly string[] = ["kind","cond","body","labels","loc"];
const KEYS97: readonly string[] = ["kind","shapeId"];
const KEYS98: readonly string[] = ["loc","scope"];
const KEYS99: readonly string[] = ["field","cases"];
const KEYS100: readonly string[] = ["name","slot","params","returns","unregisteredTrap"];
const KEYS101: readonly string[] = ["symbol","fnName","params","returns","inboundBytesTrap","inboundIntTrap","inboundCstringTrap"];
const KEYS102: readonly string[] = ["code","teaching","remediation"];
const KEYS103: readonly string[] = ["kind","method","receiver","args","type","loc"];
const KEYS104: readonly string[] = ["kind","arr","index","type","loc"];
const KEYS105: readonly string[] = ["kind","arr","index","type","loc"];
const KEYS106: readonly string[] = ["kind","elems","spreads","capacity","type","loc"];
const KEYS107: readonly string[] = ["kind","length","type","loc"];
const KEYS108: readonly string[] = ["kind","arr","index","type","loc"];
const KEYS109: readonly string[] = ["kind","localId","value","type","loc"];
const KEYS110: readonly string[] = ["kind","value","type","adopt","loc"];
const KEYS111: readonly string[] = ["kind","value","promiseTag","type","loc"];
const KEYS112: readonly string[] = ["kind","op","left","right","type","loc"];
const KEYS113: readonly string[] = ["kind","value","type","loc"];
const KEYS114: readonly string[] = ["kind","method","receiver","args","type","loc","invalidNaN"];
const KEYS115: readonly string[] = ["kind","source","from","type","loc"];
const KEYS116: readonly string[] = ["kind","callee","args","type","loc"];
const KEYS117: readonly string[] = ["kind","callee","receiver","args","type","loc"];
const KEYS118: readonly string[] = ["kind","value","className","type","loc"];
const KEYS119: readonly string[] = ["kind","value","type","loc"];
const KEYS120: readonly string[] = ["kind","value","test","className","negated","type","loc"];
const KEYS121: readonly string[] = ["kind","value","type","loc"];
const KEYS122: readonly string[] = ["kind","id","type","loc"];
const KEYS123: readonly string[] = ["kind","className","type","loc","captures"];
const KEYS124: readonly string[] = ["kind","fnName","captures","adapts","type","loc"];
const KEYS125: readonly string[] = ["kind","value","type","loc"];
const KEYS126: readonly string[] = ["kind","elems","type","loc"];
const KEYS127: readonly string[] = ["kind","callee","receiver","calleeName","calleeNameValue","args","spreads","type","loc"];
const KEYS128: readonly string[] = ["kind","value","preserveRefs","adopt","exact","partialView","inferredSite","origin","pathIndex","type","loc"];
const KEYS129: readonly string[] = ["kind","value","spelling","firstProp","type","loc"];
const KEYS130: readonly string[] = ["kind","value","type","loc","liveRef","fnName","fnLength"];
const KEYS131: readonly string[] = ["kind","key","negated","value","type","loc"];
const KEYS132: readonly string[] = ["kind","recv","method","calleeName","calleeNameValue","args","type","loc"];
const KEYS133: readonly string[] = ["kind","value","count","notIterableMessage","type","loc"];
const KEYS134: readonly string[] = ["kind","key","optional","value","type","loc"];
const KEYS135: readonly string[] = ["kind","fields","type","loc"];
const KEYS136: readonly string[] = ["kind","left","right","negated","type","loc"];
const KEYS137: readonly string[] = ["kind","test","bytesElem","negated","value","type","loc"];
const KEYS138: readonly string[] = ["kind","import","args","type","loc"];
const KEYS139: readonly string[] = ["kind","unionId","type","loc"];
const KEYS140: readonly string[] = ["kind","obj","className","field","type","loc"];
const KEYS141: readonly string[] = ["kind","op","prefix","obj","className","field","fieldDyn","type","loc"];
const KEYS142: readonly string[] = ["kind","mode","gen","arg","type","loc"];
const KEYS143: readonly string[] = ["kind","op","prefix","localId","type","loc"];
const KEYS144: readonly string[] = ["kind","value","className","type","loc"];
const KEYS145: readonly string[] = ["kind","value","classValue","type","loc"];
const KEYS146: readonly string[] = ["kind","name","args","type","loc"];
const KEYS147: readonly string[] = ["kind","value","indent","circular","type","loc"];
const KEYS148: readonly string[] = ["kind","fn","args","type","loc","prototypeIdentityOnly","realTimer","assertOptions","bindsThis"];
const KEYS149: readonly string[] = ["kind","op","left","right","type","loc"];
const KEYS150: readonly string[] = ["kind","method","receiver","args","type","loc"];
const KEYS151: readonly string[] = ["kind","seed","type","loc"];
const KEYS152: readonly string[] = ["kind","moduleId","type","loc"];
const KEYS153: readonly string[] = ["kind","className","args","type","loc"];
const KEYS154: readonly string[] = ["kind","executor","type","loc"];
const KEYS155: readonly string[] = ["kind","callee","args","type","loc"];
const KEYS156: readonly string[] = ["kind","left","right","type","loc"];
const KEYS157: readonly string[] = ["kind","value","spelling","type","loc"];
const KEYS158: readonly string[] = ["kind","id","receiver","body","type","loc"];
const KEYS159: readonly string[] = ["kind","left","right","retag","type","loc"];
const KEYS160: readonly string[] = ["kind","value","type","loc"];
const KEYS161: readonly string[] = ["kind","type","loc"];
const KEYS162: readonly string[] = ["kind","source","overrides","type","loc"];
const KEYS163: readonly string[] = ["kind","obj","shapeId","field","type","loc"];
const KEYS164: readonly string[] = ["kind","obj","shapeId","field","type","loc"];
const KEYS165: readonly string[] = ["kind","obj","shapeId","key","overflowOnly","missNaN","type","loc"];
const KEYS166: readonly string[] = ["kind","fields","nullProto","type","loc"];
const KEYS167: readonly string[] = ["kind","obj","shapeId","type","loc"];
const KEYS168: readonly string[] = ["kind","obj","shapeId","key","type","loc"];
const KEYS169: readonly string[] = ["kind","obj","shapeId","type","loc"];
const KEYS170: readonly string[] = ["kind","method","receiver","args","type","loc"];
const KEYS171: readonly string[] = ["kind","pattern","flags","type","loc"];
const KEYS172: readonly string[] = ["kind","type","loc"];
const KEYS173: readonly string[] = ["kind","stmts","result","generatorDelegate","diverges","type","loc"];
const KEYS174: readonly string[] = ["kind","method","receiver","args","type","loc"];
const KEYS175: readonly string[] = ["kind","seed","type","loc"];
const KEYS176: readonly string[] = ["kind","op","left","right","type","loc"];
const KEYS177: readonly string[] = ["kind","left","right","type","loc"];
const KEYS178: readonly string[] = ["kind","negated","left","right","type","loc"];
const KEYS179: readonly string[] = ["kind","method","receiver","args","type","loc"];
const KEYS180: readonly string[] = ["kind","value","type","loc"];
const KEYS181: readonly string[] = ["kind","key","cooked","type","loc"];
const KEYS182: readonly string[] = ["kind","cond","then","else_","type","loc"];
const KEYS183: readonly string[] = ["kind","operand","type","loc"];
const KEYS184: readonly string[] = ["kind","operand","type","loc"];
const KEYS185: readonly string[] = ["kind","op","operand","type","loc"];
const KEYS186: readonly string[] = ["kind","unionId","field","value","type","loc"];
const KEYS187: readonly string[] = ["kind","unionId","negated","sameValue","left","right","type","loc"];
const KEYS188: readonly string[] = ["kind","unionId","tag","union","func","negated","type","loc"];
const KEYS189: readonly string[] = ["kind","unionId","tag","negated","value","type","loc"];
const KEYS190: readonly string[] = ["kind","unionId","key","value","type","loc"];
const KEYS191: readonly string[] = ["kind","unionId","tag","value","type","loc"];
const KEYS192: readonly string[] = ["kind","fromId","unionId","tags","value","type","loc"];
const KEYS193: readonly string[] = ["kind","unionId","tag","value","type","loc"];
const KEYS194: readonly string[] = ["kind","unit","type","loc"];
const KEYS195: readonly string[] = ["kind","value","type","loc"];
const KEYS196: readonly string[] = ["kind","localId","type","loc"];
const KEYS197: readonly string[] = ["kind","className","method","args","type","loc","targets"];
const KEYS198: readonly string[] = ["kind","value","awaited","delegated","captureCompletion","type","loc"];
const KEYS199: readonly string[] = ["name","type"];
const KEYS200: readonly string[] = ["name","type"];
const KEYS201: readonly string[] = ["path","size","sha256","placeholder"];
const KEYS202: readonly string[] = ["path","target"];
const KEYS203: readonly string[] = ["diff","skipPrototype"];
const KEYS204: readonly string[] = ["returnType"];
const KEYS205: readonly string[] = ["test","body"];
const KEYS206: readonly string[] = ["field","globalId"];
const KEYS207: readonly string[] = ["field","wellKnown"];
const KEYS208: readonly string[] = ["tag","values"];
const KEYS209: readonly string[] = ["context"];
const KEYS210: readonly string[] = ["callback"];
const KEYS211: readonly string[] = ["callback"];
const KEYS212: readonly string[] = ["arg","what"];
const KEYS213: readonly string[] = ["key","value"];
const KEYS214: readonly string[] = ["key","value"];
const KEYS215: readonly string[] = ["name","value"];
const KEYS216: readonly string[] = ["name","value","overflow"];
const KEYS217: readonly string[] = ["id","params","returns","lifetime","invoke"];
const KEYS218: readonly string[] = ["release","params","returns"];

function encIrModule(w: IrWriter, v: IrModule): void {
  w.keys(Object.keys(v), KEYS0);
  w.num(v.irVersion);
  w.str(v.sourceFile);
  encT2(w, v.functions);
  if (v.classes === undefined) w.byte(0);
  else {
    w.byte(1);
    encT3(w, v.classes);
  }
  if (v.globals === undefined) w.byte(0);
  else {
    w.byte(1);
    encT4(w, v.globals);
  }
  if (v.records === undefined) w.byte(0);
  else {
    w.byte(1);
    encT5(w, v.records);
  }
  if (v.unions === undefined) w.byte(0);
  else {
    w.byte(1);
    encT6(w, v.unions);
  }
  w.str(v.entry);
  if (v.workers === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.workers);
  }
  if (v.declBoundary === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.declBoundary);
  }
  if (v.inferredFactFiles === undefined) w.byte(0);
  else {
    w.byte(1);
    encT7(w, v.inferredFactFiles);
  }
  if (v.declOrigins === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.declOrigins);
  }
  if (v.lifetimeRegions === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.lifetimeRegions);
  }
  if (v.foreignElementKeys === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.foreignElementKeys);
  }
  if (v.recordLinks === undefined) w.byte(0);
  else {
    w.byte(1);
    encT9(w, v.recordLinks);
  }
  if (v.threadSlotKeys === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.threadSlotKeys);
  }
  if (v.freezableArrays === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.freezableArrays);
  }
  if (v.sloppyDynWrites === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.sloppyDynWrites);
  }
  if (v.untypedIntegrity === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.untypedIntegrity);
  }
  if (v.commonJsEntry === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.commonJsEntry);
  }
  if (v.nodeIsland === undefined) w.byte(0);
  else {
    w.byte(1);
    encT10(w, v.nodeIsland);
  }
  if (v.ffiImports === undefined) w.byte(0);
  else {
    w.byte(1);
    encT11(w, v.ffiImports);
  }
  if (v.lib === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrLibSection(w, v.lib);
  }
  if (v.contracts === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrContracts(w, v.contracts);
  }
  if (v.int32ArrayCandidates === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.int32ArrayCandidates);
  }
  if (v.wasmModules === undefined) w.byte(0);
  else {
    w.byte(1);
    encT14(w, v.wasmModules);
  }
  if (v.wasmUntranslated === undefined) w.byte(0);
  else {
    w.byte(1);
    encT15(w, v.wasmUntranslated);
  }
  if (v.wasmCustomSections === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.wasmCustomSections);
  }
}
function decIrModule(r: IrReader): IrModule {
  const f0 = (r.num() as NonNullable<IrModule["irVersion"]>);
  const f1 = r.str();
  const f2 = decT2(r);
  const f3 = r.tag(2, "IrModule.classes") === 0 ? undefined : decT3(r);
  const f4 = r.tag(2, "IrModule.globals") === 0 ? undefined : decT4(r);
  const f5 = r.tag(2, "IrModule.records") === 0 ? undefined : decT5(r);
  const f6 = r.tag(2, "IrModule.unions") === 0 ? undefined : decT6(r);
  const f7 = r.str();
  const f8 = r.tag(2, "IrModule.workers") === 0 ? undefined : r.bool();
  const f9 = r.tag(2, "IrModule.declBoundary") === 0 ? undefined : (r.bool() as NonNullable<IrModule["declBoundary"]>);
  const f10 = r.tag(2, "IrModule.inferredFactFiles") === 0 ? undefined : decT7(r);
  const f11 = r.tag(2, "IrModule.declOrigins") === 0 ? undefined : decT8(r);
  const f12 = r.tag(2, "IrModule.lifetimeRegions") === 0 ? undefined : (r.bool() as NonNullable<IrModule["lifetimeRegions"]>);
  const f13 = r.tag(2, "IrModule.foreignElementKeys") === 0 ? undefined : decT8(r);
  const f14 = r.tag(2, "IrModule.recordLinks") === 0 ? undefined : decT9(r);
  const f15 = r.tag(2, "IrModule.threadSlotKeys") === 0 ? undefined : decT8(r);
  const f16 = r.tag(2, "IrModule.freezableArrays") === 0 ? undefined : decT8(r);
  const f17 = r.tag(2, "IrModule.sloppyDynWrites") === 0 ? undefined : decT8(r);
  const f18 = r.tag(2, "IrModule.untypedIntegrity") === 0 ? undefined : (r.bool() as NonNullable<IrModule["untypedIntegrity"]>);
  const f19 = r.tag(2, "IrModule.commonJsEntry") === 0 ? undefined : r.bool();
  const f20 = r.tag(2, "IrModule.nodeIsland") === 0 ? undefined : decT10(r);
  const f21 = r.tag(2, "IrModule.ffiImports") === 0 ? undefined : decT11(r);
  const f22 = r.tag(2, "IrModule.lib") === 0 ? undefined : decIrLibSection(r);
  const f23 = r.tag(2, "IrModule.contracts") === 0 ? undefined : decIrContracts(r);
  const f24 = r.tag(2, "IrModule.int32ArrayCandidates") === 0 ? undefined : decT8(r);
  const f25 = r.tag(2, "IrModule.wasmModules") === 0 ? undefined : decT14(r);
  const f26 = r.tag(2, "IrModule.wasmUntranslated") === 0 ? undefined : decT15(r);
  const f27 = r.tag(2, "IrModule.wasmCustomSections") === 0 ? undefined : r.bool();
  const o: IrModule = { irVersion: f0, sourceFile: f1, functions: f2, ...(f3 !== undefined ? { classes: f3 } : {}), ...(f4 !== undefined ? { globals: f4 } : {}), ...(f5 !== undefined ? { records: f5 } : {}), ...(f6 !== undefined ? { unions: f6 } : {}), entry: f7, ...(f8 !== undefined ? { workers: f8 } : {}), ...(f9 !== undefined ? { declBoundary: f9 } : {}), ...(f10 !== undefined ? { inferredFactFiles: f10 } : {}), ...(f11 !== undefined ? { declOrigins: f11 } : {}), ...(f12 !== undefined ? { lifetimeRegions: f12 } : {}), ...(f13 !== undefined ? { foreignElementKeys: f13 } : {}), ...(f14 !== undefined ? { recordLinks: f14 } : {}), ...(f15 !== undefined ? { threadSlotKeys: f15 } : {}), ...(f16 !== undefined ? { freezableArrays: f16 } : {}), ...(f17 !== undefined ? { sloppyDynWrites: f17 } : {}), ...(f18 !== undefined ? { untypedIntegrity: f18 } : {}), ...(f19 !== undefined ? { commonJsEntry: f19 } : {}), ...(f20 !== undefined ? { nodeIsland: f20 } : {}), ...(f21 !== undefined ? { ffiImports: f21 } : {}), ...(f22 !== undefined ? { lib: f22 } : {}), ...(f23 !== undefined ? { contracts: f23 } : {}), ...(f24 !== undefined ? { int32ArrayCandidates: f24 } : {}), ...(f25 !== undefined ? { wasmModules: f25 } : {}), ...(f26 !== undefined ? { wasmUntranslated: f26 } : {}), ...(f27 !== undefined ? { wasmCustomSections: f27 } : {}) };
  return o;
}

function encIrFunction(w: IrWriter, v: IrFunction): void {
  w.keys(Object.keys(v), KEYS1);
  w.str(v.name);
  if (v.sourceName === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.sourceName);
  }
  if (v.displayName === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.displayName);
  }
  if (v.ownsPrototype === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.ownsPrototype);
  }
  encT16(w, v.params);
  encIrType(w, v.returnType);
  encT18(w, v.locals);
  if (v.captures === undefined) w.byte(0);
  else {
    w.byte(1);
    encT16(w, v.captures);
  }
  if (v.classCaptures === undefined) w.byte(0);
  else {
    w.byte(1);
    encT19(w, v.classCaptures);
  }
  encT20(w, v.body);
  encSrcLoc(w, v.loc);
  if (v.jsEntry === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.jsEntry);
  }
  if (v.tier === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.tier);
  }
  if (v.speculativeDispatch === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.speculativeDispatch);
  }
  if (v.fastRead === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.fastRead);
  }
  if (v.plainLoops === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.plainLoops);
  }
  if (v.async === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.async);
  }
  if (v.generator === undefined) w.byte(0);
  else {
    w.byte(1);
    encT22(w, v.generator);
  }
  if (v.asyncCacheGlobal === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.asyncCacheGlobal);
  }
  if (v.asyncCycleCacheGlobal === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.asyncCycleCacheGlobal);
  }
}
function decIrFunction(r: IrReader): IrFunction {
  const f0 = r.str();
  const f1 = r.tag(2, "IrFunction.sourceName") === 0 ? undefined : r.str();
  const f2 = r.tag(2, "IrFunction.displayName") === 0 ? undefined : r.str();
  const f3 = r.tag(2, "IrFunction.ownsPrototype") === 0 ? undefined : (r.bool() as NonNullable<IrFunction["ownsPrototype"]>);
  const f4 = decT16(r);
  const f5 = decIrType(r);
  const f6 = decT18(r);
  const f7 = r.tag(2, "IrFunction.captures") === 0 ? undefined : decT16(r);
  const f8 = r.tag(2, "IrFunction.classCaptures") === 0 ? undefined : decT19(r);
  const f9 = decT20(r);
  const f10 = decSrcLoc(r);
  const f11 = r.tag(2, "IrFunction.jsEntry") === 0 ? undefined : r.str();
  const f12 = r.tag(2, "IrFunction.tier") === 0 ? undefined : (r.str() as NonNullable<IrFunction["tier"]>);
  const f13 = r.tag(2, "IrFunction.speculativeDispatch") === 0 ? undefined : r.bool();
  const f14 = r.tag(2, "IrFunction.fastRead") === 0 ? undefined : (r.str() as NonNullable<IrFunction["fastRead"]>);
  const f15 = r.tag(2, "IrFunction.plainLoops") === 0 ? undefined : (r.bool() as NonNullable<IrFunction["plainLoops"]>);
  const f16 = r.tag(2, "IrFunction.async") === 0 ? undefined : (r.bool() as NonNullable<IrFunction["async"]>);
  const f17 = r.tag(2, "IrFunction.generator") === 0 ? undefined : decT22(r);
  const f18 = r.tag(2, "IrFunction.asyncCacheGlobal") === 0 ? undefined : r.str();
  const f19 = r.tag(2, "IrFunction.asyncCycleCacheGlobal") === 0 ? undefined : r.str();
  const o: IrFunction = { name: f0, ...(f1 !== undefined ? { sourceName: f1 } : {}), ...(f2 !== undefined ? { displayName: f2 } : {}), ...(f3 !== undefined ? { ownsPrototype: f3 } : {}), params: f4, returnType: f5, locals: f6, ...(f7 !== undefined ? { captures: f7 } : {}), ...(f8 !== undefined ? { classCaptures: f8 } : {}), body: f9, loc: f10, ...(f11 !== undefined ? { jsEntry: f11 } : {}), ...(f12 !== undefined ? { tier: f12 } : {}), ...(f13 !== undefined ? { speculativeDispatch: f13 } : {}), ...(f14 !== undefined ? { fastRead: f14 } : {}), ...(f15 !== undefined ? { plainLoops: f15 } : {}), ...(f16 !== undefined ? { async: f16 } : {}), ...(f17 !== undefined ? { generator: f17 } : {}), ...(f18 !== undefined ? { asyncCacheGlobal: f18 } : {}), ...(f19 !== undefined ? { asyncCycleCacheGlobal: f19 } : {}) };
  return o;
}

function encT2(w: IrWriter, v: NonNullable<IrModule["functions"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrFunction(w, item);
  }
}
function decT2(r: IrReader): NonNullable<IrModule["functions"]> {
  const length = r.length();
  const out: NonNullable<IrModule["functions"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrFunction(r));
  return out;
}

function encT3(w: IrWriter, v: NonNullable<IrModule["classes"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrClassDef(w, item);
  }
}
function decT3(r: IrReader): NonNullable<IrModule["classes"]> {
  const length = r.length();
  const out: NonNullable<IrModule["classes"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrClassDef(r));
  return out;
}

function encT4(w: IrWriter, v: NonNullable<IrModule["globals"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrGlobal(w, item);
  }
}
function decT4(r: IrReader): NonNullable<IrModule["globals"]> {
  const length = r.length();
  const out: NonNullable<IrModule["globals"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrGlobal(r));
  return out;
}

function encT5(w: IrWriter, v: NonNullable<IrModule["records"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrRecordShape(w, item);
  }
}
function decT5(r: IrReader): NonNullable<IrModule["records"]> {
  const length = r.length();
  const out: NonNullable<IrModule["records"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrRecordShape(r));
  return out;
}

function encT6(w: IrWriter, v: NonNullable<IrModule["unions"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrUnionDef(w, item);
  }
}
function decT6(r: IrReader): NonNullable<IrModule["unions"]> {
  const length = r.length();
  const out: NonNullable<IrModule["unions"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrUnionDef(r));
  return out;
}

function encT7(w: IrWriter, v: NonNullable<IrModule["inferredFactFiles"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT27(w, item);
  }
}
function decT7(r: IrReader): NonNullable<IrModule["inferredFactFiles"]> {
  const length = r.length();
  const out: NonNullable<IrModule["inferredFactFiles"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT27(r));
  return out;
}

function encT8(w: IrWriter, v: NonNullable<IrModule["declOrigins"]>): void {
  w.length(v.length);
  for (const item of v) {
    w.str(item);
  }
}
function decT8(r: IrReader): NonNullable<IrModule["declOrigins"]> {
  const length = r.length();
  const out: NonNullable<IrModule["declOrigins"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(r.str());
  return out;
}

function encT9(w: IrWriter, v: NonNullable<IrModule["recordLinks"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrRecordLink(w, item);
  }
}
function decT9(r: IrReader): NonNullable<IrModule["recordLinks"]> {
  const length = r.length();
  const out: NonNullable<IrModule["recordLinks"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrRecordLink(r));
  return out;
}

function encT10(w: IrWriter, v: NonNullable<IrModule["nodeIsland"]>): void {
  w.keys(Object.keys(v), KEYS2);
  w.str(v.libnode);
  w.str(v.nodeVersion);
  if (v.modules === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrNodeIslandModules(w, v.modules);
  }
}
function decT10(r: IrReader): NonNullable<IrModule["nodeIsland"]> {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = r.tag(2, "IrModule.nodeIsland.modules") === 0 ? undefined : decIrNodeIslandModules(r);
  const o: NonNullable<IrModule["nodeIsland"]> = { libnode: f0, nodeVersion: f1, ...(f2 !== undefined ? { modules: f2 } : {}) };
  return o;
}

function encT11(w: IrWriter, v: NonNullable<IrModule["ffiImports"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrFfiImport(w, item);
  }
}
function decT11(r: IrReader): NonNullable<IrModule["ffiImports"]> {
  const length = r.length();
  const out: NonNullable<IrModule["ffiImports"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrFfiImport(r));
  return out;
}

function encIrLibSection(w: IrWriter, v: IrLibSection): void {
  w.keys(Object.keys(v), KEYS3);
  w.str(v.profileName);
  w.str(v.prefix);
  w.str(v.initSymbol);
  w.str(v.sinkRegisterSymbol);
  if (v.collectSymbol === null) w.byte(0);
  else {
    w.byte(1);
    w.str(v.collectSymbol);
  }
  if (v.resultResetSymbol === null) w.byte(0);
  else {
    w.byte(1);
    w.str(v.resultResetSymbol);
  }
  w.bool(v.threadInstances);
  if (v.callbackRegisterSymbol === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.callbackRegisterSymbol);
  }
  if (v.callbacks === undefined) w.byte(0);
  else {
    w.byte(1);
    encT31(w, v.callbacks);
  }
  encT32(w, v.exports);
  encT33(w, v.trapOverlays);
  if (v.identity === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrLibIdentity(w, v.identity);
  }
}
function decIrLibSection(r: IrReader): IrLibSection {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = r.str();
  const f3 = r.str();
  const f4 = r.tag(2, "IrModule.lib.collectSymbol") === 0 ? null : r.str();
  const f5 = r.tag(2, "IrModule.lib.resultResetSymbol") === 0 ? null : r.str();
  const f6 = r.bool();
  const f7 = r.tag(2, "IrModule.lib.callbackRegisterSymbol") === 0 ? undefined : r.str();
  const f8 = r.tag(2, "IrModule.lib.callbacks") === 0 ? undefined : decT31(r);
  const f9 = decT32(r);
  const f10 = decT33(r);
  const f11 = r.tag(2, "IrModule.lib.identity") === 0 ? undefined : decIrLibIdentity(r);
  const o: IrLibSection = { profileName: f0, prefix: f1, initSymbol: f2, sinkRegisterSymbol: f3, collectSymbol: f4, resultResetSymbol: f5, threadInstances: f6, ...(f7 !== undefined ? { callbackRegisterSymbol: f7 } : {}), ...(f8 !== undefined ? { callbacks: f8 } : {}), exports: f9, trapOverlays: f10, ...(f11 !== undefined ? { identity: f11 } : {}) };
  return o;
}

function encIrContracts(w: IrWriter, v: IrContracts): void {
  w.keys(Object.keys(v), KEYS4);
  if (v.int32Fields === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.int32Fields);
  }
  if (v.int32Params === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.int32Params);
  }
  if (v.int32Returns === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.int32Returns);
  }
  if (v.int32Locals === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.int32Locals);
  }
  if (v.int32Elements === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.int32Elements);
  }
  if (v.noThrow === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.noThrow);
  }
  if (v.acyclic === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.acyclic);
  }
  if (v.immortalGlobals === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.immortalGlobals);
  }
  if (v.programLifetime === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.programLifetime);
  }
  if (v.inlineArrays === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.inlineArrays);
  }
}
function decIrContracts(r: IrReader): IrContracts {
  const f0 = r.tag(2, "IrModule.contracts.int32Fields") === 0 ? undefined : decT8(r);
  const f1 = r.tag(2, "IrModule.contracts.int32Params") === 0 ? undefined : decT8(r);
  const f2 = r.tag(2, "IrModule.contracts.int32Returns") === 0 ? undefined : decT8(r);
  const f3 = r.tag(2, "IrModule.contracts.int32Locals") === 0 ? undefined : decT8(r);
  const f4 = r.tag(2, "IrModule.contracts.int32Elements") === 0 ? undefined : decT8(r);
  const f5 = r.tag(2, "IrModule.contracts.noThrow") === 0 ? undefined : decT8(r);
  const f6 = r.tag(2, "IrModule.contracts.acyclic") === 0 ? undefined : decT8(r);
  const f7 = r.tag(2, "IrModule.contracts.immortalGlobals") === 0 ? undefined : decT8(r);
  const f8 = r.tag(2, "IrModule.contracts.programLifetime") === 0 ? undefined : decT8(r);
  const f9 = r.tag(2, "IrModule.contracts.inlineArrays") === 0 ? undefined : decT8(r);
  const o: IrContracts = { ...(f0 !== undefined ? { int32Fields: f0 } : {}), ...(f1 !== undefined ? { int32Params: f1 } : {}), ...(f2 !== undefined ? { int32Returns: f2 } : {}), ...(f3 !== undefined ? { int32Locals: f3 } : {}), ...(f4 !== undefined ? { int32Elements: f4 } : {}), ...(f5 !== undefined ? { noThrow: f5 } : {}), ...(f6 !== undefined ? { acyclic: f6 } : {}), ...(f7 !== undefined ? { immortalGlobals: f7 } : {}), ...(f8 !== undefined ? { programLifetime: f8 } : {}), ...(f9 !== undefined ? { inlineArrays: f9 } : {}) };
  return o;
}

function encT14(w: IrWriter, v: NonNullable<IrModule["wasmModules"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrWasmModule(w, item);
  }
}
function decT14(r: IrReader): NonNullable<IrModule["wasmModules"]> {
  const length = r.length();
  const out: NonNullable<IrModule["wasmModules"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrWasmModule(r));
  return out;
}

function encT15(w: IrWriter, v: NonNullable<IrModule["wasmUntranslated"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrWasmUntranslated(w, item);
  }
}
function decT15(r: IrReader): NonNullable<IrModule["wasmUntranslated"]> {
  const length = r.length();
  const out: NonNullable<IrModule["wasmUntranslated"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrWasmUntranslated(r));
  return out;
}

function encT16(w: IrWriter, v: NonNullable<IrFunction["params"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrParam(w, item);
  }
}
function decT16(r: IrReader): NonNullable<IrFunction["params"]> {
  const length = r.length();
  const out: NonNullable<IrFunction["params"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrParam(r));
  return out;
}

function encIrType(w: IrWriter, v: IrType): void {
  switch (v.kind) {
    case "array": {
      w.length(0);
      w.keys(Object.keys(v), KEYS5);
      encIrType(w, v.elem);
      if (v.optionalElements === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.optionalElements);
      }
      return;
    }
    case "bigint": {
      w.length(1);
      w.keys(Object.keys(v), KEYS6);
      return;
    }
    case "bigintStats": {
      w.length(2);
      w.keys(Object.keys(v), KEYS7);
      return;
    }
    case "bool": {
      w.length(3);
      w.keys(Object.keys(v), KEYS8);
      return;
    }
    case "bytes": {
      w.length(4);
      w.keys(Object.keys(v), KEYS9);
      w.str(v.elem);
      return;
    }
    case "caught": {
      w.length(5);
      w.keys(Object.keys(v), KEYS10);
      return;
    }
    case "child": {
      w.length(6);
      w.keys(Object.keys(v), KEYS11);
      return;
    }
    case "childStream": {
      w.length(7);
      w.keys(Object.keys(v), KEYS12);
      return;
    }
    case "childWriter": {
      w.length(8);
      w.keys(Object.keys(v), KEYS13);
      return;
    }
    case "classval": {
      w.length(9);
      w.keys(Object.keys(v), KEYS14);
      w.str(v.className);
      return;
    }
    case "cryptoHash": {
      w.length(10);
      w.keys(Object.keys(v), KEYS15);
      return;
    }
    case "cryptoHmac": {
      w.length(11);
      w.keys(Object.keys(v), KEYS16);
      return;
    }
    case "date": {
      w.length(12);
      w.keys(Object.keys(v), KEYS17);
      return;
    }
    case "dgramSocket": {
      w.length(13);
      w.keys(Object.keys(v), KEYS18);
      return;
    }
    case "dir": {
      w.length(14);
      w.keys(Object.keys(v), KEYS19);
      return;
    }
    case "dyn": {
      w.length(15);
      w.keys(Object.keys(v), KEYS20);
      return;
    }
    case "f64": {
      w.length(16);
      w.keys(Object.keys(v), KEYS21);
      return;
    }
    case "fileHandle": {
      w.length(17);
      w.keys(Object.keys(v), KEYS22);
      return;
    }
    case "fsWatcher": {
      w.length(18);
      w.keys(Object.keys(v), KEYS23);
      return;
    }
    case "func": {
      w.length(19);
      w.keys(Object.keys(v), KEYS24);
      encT38(w, v.params);
      encIrType(w, v.ret);
      if (v.rest === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.rest);
      }
      if (v.restAbi === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.restAbi);
      }
      if (v.argumentsAll === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.argumentsAll);
      }
      return;
    }
    case "generator": {
      w.length(20);
      w.keys(Object.keys(v), KEYS25);
      if (v.async === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.async);
      }
      encIrType(w, v.yieldT);
      encIrType(w, v.retT);
      encIrType(w, v.nextT);
      return;
    }
    case "http2Session": {
      w.length(21);
      w.keys(Object.keys(v), KEYS26);
      return;
    }
    case "http2Stream": {
      w.length(22);
      w.keys(Object.keys(v), KEYS27);
      return;
    }
    case "httpClientReq": {
      w.length(23);
      w.keys(Object.keys(v), KEYS28);
      return;
    }
    case "httpReq": {
      w.length(24);
      w.keys(Object.keys(v), KEYS29);
      return;
    }
    case "httpRes": {
      w.length(25);
      w.keys(Object.keys(v), KEYS30);
      return;
    }
    case "jsval": {
      w.length(26);
      w.keys(Object.keys(v), KEYS31);
      return;
    }
    case "map": {
      w.length(27);
      w.keys(Object.keys(v), KEYS32);
      encIrType(w, v.key);
      encIrType(w, v.value);
      return;
    }
    case "moduleNs": {
      w.length(28);
      w.keys(Object.keys(v), KEYS33);
      w.str(v.moduleId);
      return;
    }
    case "netServer": {
      w.length(29);
      w.keys(Object.keys(v), KEYS34);
      return;
    }
    case "netSocket": {
      w.length(30);
      w.keys(Object.keys(v), KEYS35);
      return;
    }
    case "nullT": {
      w.length(31);
      w.keys(Object.keys(v), KEYS36);
      return;
    }
    case "object": {
      w.length(32);
      w.keys(Object.keys(v), KEYS37);
      w.str(v.className);
      return;
    }
    case "procStream": {
      w.length(33);
      w.keys(Object.keys(v), KEYS38);
      return;
    }
    case "promise": {
      w.length(34);
      w.keys(Object.keys(v), KEYS39);
      encIrType(w, v.inner);
      return;
    }
    case "record": {
      w.length(35);
      w.keys(Object.keys(v), KEYS40);
      w.str(v.shapeId);
      return;
    }
    case "regex": {
      w.length(36);
      w.keys(Object.keys(v), KEYS41);
      return;
    }
    case "searchParams": {
      w.length(37);
      w.keys(Object.keys(v), KEYS42);
      return;
    }
    case "secureCtx": {
      w.length(38);
      w.keys(Object.keys(v), KEYS43);
      return;
    }
    case "set": {
      w.length(39);
      w.keys(Object.keys(v), KEYS44);
      encIrType(w, v.elem);
      return;
    }
    case "spawnRes": {
      w.length(40);
      w.keys(Object.keys(v), KEYS45);
      return;
    }
    case "stats": {
      w.length(41);
      w.keys(Object.keys(v), KEYS46);
      return;
    }
    case "string": {
      w.length(42);
      w.keys(Object.keys(v), KEYS47);
      return;
    }
    case "symbol": {
      w.length(43);
      w.keys(Object.keys(v), KEYS48);
      return;
    }
    case "testCtx": {
      w.length(44);
      w.keys(Object.keys(v), KEYS49);
      return;
    }
    case "undefinedT": {
      w.length(45);
      w.keys(Object.keys(v), KEYS50);
      return;
    }
    case "union": {
      w.length(46);
      w.keys(Object.keys(v), KEYS51);
      w.str(v.unionId);
      return;
    }
    case "url": {
      w.length(47);
      w.keys(Object.keys(v), KEYS52);
      return;
    }
    case "void": {
      w.length(48);
      w.keys(Object.keys(v), KEYS53);
      return;
    }
  }
  w.refuse("IrType kind " + String((v as { kind: unknown }).kind));
}
function decIrType(r: IrReader): IrType {
  switch (r.length()) {
    case 0: {
      const f0 = decIrType(r);
      const f1 = r.tag(2, "IrFunction.returnType<array>.optionalElements") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrType, { kind: "array" }>["optionalElements"]>);
      const o: Extract<IrType, { kind: "array" }> = { kind: "array", elem: f0, ...(f1 !== undefined ? { optionalElements: f1 } : {}) };
      return o;
    }
    case 1: {
      const o: Extract<IrType, { kind: "bigint" }> = { kind: "bigint" };
      return o;
    }
    case 2: {
      const o: Extract<IrType, { kind: "bigintStats" }> = { kind: "bigintStats" };
      return o;
    }
    case 3: {
      const o: Extract<IrType, { kind: "bool" }> = { kind: "bool" };
      return o;
    }
    case 4: {
      const f0 = (r.str() as NonNullable<Extract<IrType, { kind: "bytes" }>["elem"]>);
      const o: Extract<IrType, { kind: "bytes" }> = { kind: "bytes", elem: f0 };
      return o;
    }
    case 5: {
      const o: Extract<IrType, { kind: "caught" }> = { kind: "caught" };
      return o;
    }
    case 6: {
      const o: Extract<IrType, { kind: "child" }> = { kind: "child" };
      return o;
    }
    case 7: {
      const o: Extract<IrType, { kind: "childStream" }> = { kind: "childStream" };
      return o;
    }
    case 8: {
      const o: Extract<IrType, { kind: "childWriter" }> = { kind: "childWriter" };
      return o;
    }
    case 9: {
      const f0 = r.str();
      const o: Extract<IrType, { kind: "classval" }> = { kind: "classval", className: f0 };
      return o;
    }
    case 10: {
      const o: Extract<IrType, { kind: "cryptoHash" }> = { kind: "cryptoHash" };
      return o;
    }
    case 11: {
      const o: Extract<IrType, { kind: "cryptoHmac" }> = { kind: "cryptoHmac" };
      return o;
    }
    case 12: {
      const o: Extract<IrType, { kind: "date" }> = { kind: "date" };
      return o;
    }
    case 13: {
      const o: Extract<IrType, { kind: "dgramSocket" }> = { kind: "dgramSocket" };
      return o;
    }
    case 14: {
      const o: Extract<IrType, { kind: "dir" }> = { kind: "dir" };
      return o;
    }
    case 15: {
      const o: Extract<IrType, { kind: "dyn" }> = { kind: "dyn" };
      return o;
    }
    case 16: {
      const o: Extract<IrType, { kind: "f64" }> = { kind: "f64" };
      return o;
    }
    case 17: {
      const o: Extract<IrType, { kind: "fileHandle" }> = { kind: "fileHandle" };
      return o;
    }
    case 18: {
      const o: Extract<IrType, { kind: "fsWatcher" }> = { kind: "fsWatcher" };
      return o;
    }
    case 19: {
      const f0 = decT38(r);
      const f1 = decIrType(r);
      const f2 = r.tag(2, "IrFunction.returnType<func>.rest") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrType, { kind: "func" }>["rest"]>);
      const f3 = r.tag(2, "IrFunction.returnType<func>.restAbi") === 0 ? undefined : (r.str() as NonNullable<Extract<IrType, { kind: "func" }>["restAbi"]>);
      const f4 = r.tag(2, "IrFunction.returnType<func>.argumentsAll") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrType, { kind: "func" }>["argumentsAll"]>);
      const o: Extract<IrType, { kind: "func" }> = { kind: "func", params: f0, ret: f1, ...(f2 !== undefined ? { rest: f2 } : {}), ...(f3 !== undefined ? { restAbi: f3 } : {}), ...(f4 !== undefined ? { argumentsAll: f4 } : {}) };
      return o;
    }
    case 20: {
      const f0 = r.tag(2, "IrFunction.returnType<generator>.async") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrType, { kind: "generator" }>["async"]>);
      const f1 = decIrType(r);
      const f2 = decIrType(r);
      const f3 = decIrType(r);
      const o: Extract<IrType, { kind: "generator" }> = { kind: "generator", ...(f0 !== undefined ? { async: f0 } : {}), yieldT: f1, retT: f2, nextT: f3 };
      return o;
    }
    case 21: {
      const o: Extract<IrType, { kind: "http2Session" }> = { kind: "http2Session" };
      return o;
    }
    case 22: {
      const o: Extract<IrType, { kind: "http2Stream" }> = { kind: "http2Stream" };
      return o;
    }
    case 23: {
      const o: Extract<IrType, { kind: "httpClientReq" }> = { kind: "httpClientReq" };
      return o;
    }
    case 24: {
      const o: Extract<IrType, { kind: "httpReq" }> = { kind: "httpReq" };
      return o;
    }
    case 25: {
      const o: Extract<IrType, { kind: "httpRes" }> = { kind: "httpRes" };
      return o;
    }
    case 26: {
      const o: Extract<IrType, { kind: "jsval" }> = { kind: "jsval" };
      return o;
    }
    case 27: {
      const f0 = decIrType(r);
      const f1 = decIrType(r);
      const o: Extract<IrType, { kind: "map" }> = { kind: "map", key: f0, value: f1 };
      return o;
    }
    case 28: {
      const f0 = r.str();
      const o: Extract<IrType, { kind: "moduleNs" }> = { kind: "moduleNs", moduleId: f0 };
      return o;
    }
    case 29: {
      const o: Extract<IrType, { kind: "netServer" }> = { kind: "netServer" };
      return o;
    }
    case 30: {
      const o: Extract<IrType, { kind: "netSocket" }> = { kind: "netSocket" };
      return o;
    }
    case 31: {
      const o: Extract<IrType, { kind: "nullT" }> = { kind: "nullT" };
      return o;
    }
    case 32: {
      const f0 = r.str();
      const o: Extract<IrType, { kind: "object" }> = { kind: "object", className: f0 };
      return o;
    }
    case 33: {
      const o: Extract<IrType, { kind: "procStream" }> = { kind: "procStream" };
      return o;
    }
    case 34: {
      const f0 = decIrType(r);
      const o: Extract<IrType, { kind: "promise" }> = { kind: "promise", inner: f0 };
      return o;
    }
    case 35: {
      const f0 = r.str();
      const o: Extract<IrType, { kind: "record" }> = { kind: "record", shapeId: f0 };
      return o;
    }
    case 36: {
      const o: Extract<IrType, { kind: "regex" }> = { kind: "regex" };
      return o;
    }
    case 37: {
      const o: Extract<IrType, { kind: "searchParams" }> = { kind: "searchParams" };
      return o;
    }
    case 38: {
      const o: Extract<IrType, { kind: "secureCtx" }> = { kind: "secureCtx" };
      return o;
    }
    case 39: {
      const f0 = decIrType(r);
      const o: Extract<IrType, { kind: "set" }> = { kind: "set", elem: f0 };
      return o;
    }
    case 40: {
      const o: Extract<IrType, { kind: "spawnRes" }> = { kind: "spawnRes" };
      return o;
    }
    case 41: {
      const o: Extract<IrType, { kind: "stats" }> = { kind: "stats" };
      return o;
    }
    case 42: {
      const o: Extract<IrType, { kind: "string" }> = { kind: "string" };
      return o;
    }
    case 43: {
      const o: Extract<IrType, { kind: "symbol" }> = { kind: "symbol" };
      return o;
    }
    case 44: {
      const o: Extract<IrType, { kind: "testCtx" }> = { kind: "testCtx" };
      return o;
    }
    case 45: {
      const o: Extract<IrType, { kind: "undefinedT" }> = { kind: "undefinedT" };
      return o;
    }
    case 46: {
      const f0 = r.str();
      const o: Extract<IrType, { kind: "union" }> = { kind: "union", unionId: f0 };
      return o;
    }
    case 47: {
      const o: Extract<IrType, { kind: "url" }> = { kind: "url" };
      return o;
    }
    case 48: {
      const o: Extract<IrType, { kind: "void" }> = { kind: "void" };
      return o;
    }
  }
  throw new Error("IR codec: invalid IrType kind");
}

function encT18(w: IrWriter, v: NonNullable<IrFunction["locals"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrLocal(w, item);
  }
}
function decT18(r: IrReader): NonNullable<IrFunction["locals"]> {
  const length = r.length();
  const out: NonNullable<IrFunction["locals"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrLocal(r));
  return out;
}

function encT19(w: IrWriter, v: NonNullable<IrFunction["classCaptures"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT40(w, item);
  }
}
function decT19(r: IrReader): NonNullable<IrFunction["classCaptures"]> {
  const length = r.length();
  const out: NonNullable<IrFunction["classCaptures"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT40(r));
  return out;
}

function encT20(w: IrWriter, v: NonNullable<IrFunction["body"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrStmt(w, item);
  }
}
function decT20(r: IrReader): NonNullable<IrFunction["body"]> {
  const length = r.length();
  const out: NonNullable<IrFunction["body"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrStmt(r));
  return out;
}

function encSrcLoc(w: IrWriter, v: SrcLoc): void {
  w.keys(Object.keys(v), KEYS54);
  w.file(v.file);
  w.num(v.start);
  w.num(v.end);
}
function decSrcLoc(r: IrReader): SrcLoc {
  const f0 = r.str();
  const f1 = r.num();
  const f2 = r.num();
  const o: SrcLoc = { file: f0, start: f1, end: f2 };
  return o;
}

function encT22(w: IrWriter, v: NonNullable<IrFunction["generator"]>): void {
  w.keys(Object.keys(v), KEYS55);
  encIrType(w, v.yieldT);
  encIrType(w, v.nextT);
  encT42(w, v.resultType);
  if (v.closesSource === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.closesSource);
  }
  if (v.tag === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.tag);
  }
  if (v.inheritsTag === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.inheritsTag);
  }
  if (v.bindAtCall === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.bindAtCall);
  }
}
function decT22(r: IrReader): NonNullable<IrFunction["generator"]> {
  const f0 = decIrType(r);
  const f1 = decIrType(r);
  const f2 = decT42(r);
  const f3 = r.tag(2, "IrFunction.generator.closesSource") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<IrFunction["generator"]>["closesSource"]>);
  const f4 = r.tag(2, "IrFunction.generator.tag") === 0 ? undefined : r.str();
  const f5 = r.tag(2, "IrFunction.generator.inheritsTag") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<IrFunction["generator"]>["inheritsTag"]>);
  const f6 = r.tag(2, "IrFunction.generator.bindAtCall") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<IrFunction["generator"]>["bindAtCall"]>);
  const o: NonNullable<IrFunction["generator"]> = { yieldT: f0, nextT: f1, resultType: f2, ...(f3 !== undefined ? { closesSource: f3 } : {}), ...(f4 !== undefined ? { tag: f4 } : {}), ...(f5 !== undefined ? { inheritsTag: f5 } : {}), ...(f6 !== undefined ? { bindAtCall: f6 } : {}) };
  return o;
}

function encIrClassDef(w: IrWriter, v: IrClassDef): void {
  w.keys(Object.keys(v), KEYS56);
  w.str(v.name);
  if (v.localCaptures === undefined) w.byte(0);
  else {
    w.byte(1);
    encT16(w, v.localCaptures);
  }
  if (v.localBaseCapture === undefined) w.byte(0);
  else {
    w.byte(1);
    w.num(v.localBaseCapture);
  }
  if (v.baseValueGlobal === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.baseValueGlobal);
  }
  if (v.jsName === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.jsName);
  }
  if (v.jsLength === undefined) w.byte(0);
  else {
    w.byte(1);
    w.num(v.jsLength);
  }
  if (v.ownStaticFields === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.ownStaticFields);
  }
  if (v.prototypeDataHelper === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.prototypeDataHelper);
  }
  if (v.instancePrototypeHelper === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.instancePrototypeHelper);
  }
  if (v.stringTagHelper === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.stringTagHelper);
  }
  if (v.tracksOwnFields === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.tracksOwnFields);
  }
  if (v.errorNameAfter === undefined) w.byte(0);
  else if (v.errorNameAfter === null) w.byte(1);
  else {
    w.byte(2);
    w.str(v.errorNameAfter);
  }
  if (v.errorBagOrder === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.errorBagOrder);
  }
  if (v.symbolFields === undefined) w.byte(0);
  else {
    w.byte(1);
    encT43(w, v.symbolFields);
  }
  if (v.runtime === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.runtime);
  }
  if (v.arrayElem === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrType(w, v.arrayElem);
  }
  if (v.arrayFields === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.arrayFields);
  }
  if (v.arraySpecies === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.arraySpecies);
  }
  if (v.base === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.base);
  }
  encT44(w, v.fields);
  if (v.methods === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.methods);
  }
  if (v.prototypeNames === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.prototypeNames);
  }
  if (v.abstract === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.abstract);
  }
  if (v.abstractMethods === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.abstractMethods);
  }
  if (v.genericOf === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.genericOf);
  }
  encSrcLoc(w, v.loc);
}
function decIrClassDef(r: IrReader): IrClassDef {
  const f0 = r.str();
  const f1 = r.tag(2, "IrModule.classes[].localCaptures") === 0 ? undefined : decT16(r);
  const f2 = r.tag(2, "IrModule.classes[].localBaseCapture") === 0 ? undefined : r.num();
  const f3 = r.tag(2, "IrModule.classes[].baseValueGlobal") === 0 ? undefined : r.str();
  const f4 = r.tag(2, "IrModule.classes[].jsName") === 0 ? undefined : r.str();
  const f5 = r.tag(2, "IrModule.classes[].jsLength") === 0 ? undefined : r.num();
  const f6 = r.tag(2, "IrModule.classes[].ownStaticFields") === 0 ? undefined : (r.bool() as NonNullable<IrClassDef["ownStaticFields"]>);
  const f7 = r.tag(2, "IrModule.classes[].prototypeDataHelper") === 0 ? undefined : r.str();
  const f8 = r.tag(2, "IrModule.classes[].instancePrototypeHelper") === 0 ? undefined : r.str();
  const f9 = r.tag(2, "IrModule.classes[].stringTagHelper") === 0 ? undefined : r.str();
  const f10 = r.tag(2, "IrModule.classes[].tracksOwnFields") === 0 ? undefined : r.bool();
  const f11 = r.tag(3, "IrModule.classes[].errorNameAfter") === 0 ? undefined : r.lastTag === 1 ? null : r.str();
  const f12 = r.tag(2, "IrModule.classes[].errorBagOrder") === 0 ? undefined : r.bool();
  const f13 = r.tag(2, "IrModule.classes[].symbolFields") === 0 ? undefined : decT43(r);
  const f14 = r.tag(2, "IrModule.classes[].runtime") === 0 ? undefined : (r.bool() as NonNullable<IrClassDef["runtime"]>);
  const f15 = r.tag(2, "IrModule.classes[].arrayElem") === 0 ? undefined : decIrType(r);
  const f16 = r.tag(2, "IrModule.classes[].arrayFields") === 0 ? undefined : r.str();
  const f17 = r.tag(2, "IrModule.classes[].arraySpecies") === 0 ? undefined : r.str();
  const f18 = r.tag(2, "IrModule.classes[].base") === 0 ? undefined : r.str();
  const f19 = decT44(r);
  const f20 = r.tag(2, "IrModule.classes[].methods") === 0 ? undefined : decT8(r);
  const f21 = r.tag(2, "IrModule.classes[].prototypeNames") === 0 ? undefined : decT8(r);
  const f22 = r.tag(2, "IrModule.classes[].abstract") === 0 ? undefined : (r.bool() as NonNullable<IrClassDef["abstract"]>);
  const f23 = r.tag(2, "IrModule.classes[].abstractMethods") === 0 ? undefined : decT8(r);
  const f24 = r.tag(2, "IrModule.classes[].genericOf") === 0 ? undefined : r.str();
  const f25 = decSrcLoc(r);
  const o: IrClassDef = { name: f0, ...(f1 !== undefined ? { localCaptures: f1 } : {}), ...(f2 !== undefined ? { localBaseCapture: f2 } : {}), ...(f3 !== undefined ? { baseValueGlobal: f3 } : {}), ...(f4 !== undefined ? { jsName: f4 } : {}), ...(f5 !== undefined ? { jsLength: f5 } : {}), ...(f6 !== undefined ? { ownStaticFields: f6 } : {}), ...(f7 !== undefined ? { prototypeDataHelper: f7 } : {}), ...(f8 !== undefined ? { instancePrototypeHelper: f8 } : {}), ...(f9 !== undefined ? { stringTagHelper: f9 } : {}), ...(f10 !== undefined ? { tracksOwnFields: f10 } : {}), ...(f11 !== undefined ? { errorNameAfter: f11 } : {}), ...(f12 !== undefined ? { errorBagOrder: f12 } : {}), ...(f13 !== undefined ? { symbolFields: f13 } : {}), ...(f14 !== undefined ? { runtime: f14 } : {}), ...(f15 !== undefined ? { arrayElem: f15 } : {}), ...(f16 !== undefined ? { arrayFields: f16 } : {}), ...(f17 !== undefined ? { arraySpecies: f17 } : {}), ...(f18 !== undefined ? { base: f18 } : {}), fields: f19, ...(f20 !== undefined ? { methods: f20 } : {}), ...(f21 !== undefined ? { prototypeNames: f21 } : {}), ...(f22 !== undefined ? { abstract: f22 } : {}), ...(f23 !== undefined ? { abstractMethods: f23 } : {}), ...(f24 !== undefined ? { genericOf: f24 } : {}), loc: f25 };
  return o;
}

function encIrGlobal(w: IrWriter, v: IrGlobal): void {
  w.keys(Object.keys(v), KEYS57);
  w.str(v.id);
  w.str(v.name);
  encIrType(w, v.type);
  w.bool(v.mutable);
  if (v.tdz === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.tdz);
  }
  if (v.initFlag === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.initFlag);
  }
  if (v.source === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrBindingSource(w, v.source);
  }
}
function decIrGlobal(r: IrReader): IrGlobal {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = decIrType(r);
  const f3 = r.bool();
  const f4 = r.tag(2, "IrModule.globals[].tdz") === 0 ? undefined : (r.bool() as NonNullable<IrGlobal["tdz"]>);
  const f5 = r.tag(2, "IrModule.globals[].initFlag") === 0 ? undefined : r.str();
  const f6 = r.tag(2, "IrModule.globals[].source") === 0 ? undefined : decIrBindingSource(r);
  const o: IrGlobal = { id: f0, name: f1, type: f2, mutable: f3, ...(f4 !== undefined ? { tdz: f4 } : {}), ...(f5 !== undefined ? { initFlag: f5 } : {}), ...(f6 !== undefined ? { source: f6 } : {}) };
  return o;
}

function encIrRecordShape(w: IrWriter, v: IrRecordShape): void {
  w.keys(Object.keys(v), KEYS58);
  w.str(v.id);
  encT46(w, v.fields);
  if (v.tuple === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.tuple);
  }
  if (v.indexValue === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrType(w, v.indexValue);
  }
  if (v.freezable === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.freezable);
  }
  if (v.declaredOrder === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.declaredOrder);
  }
  if (v.accessorOrder === undefined) w.byte(0);
  else {
    w.byte(1);
    encT8(w, v.accessorOrder);
  }
  if (v.orderVariants === undefined) w.byte(0);
  else {
    w.byte(1);
    encT47(w, v.orderVariants);
  }
}
function decIrRecordShape(r: IrReader): IrRecordShape {
  const f0 = r.str();
  const f1 = decT46(r);
  const f2 = r.tag(2, "IrModule.records[].tuple") === 0 ? undefined : (r.bool() as NonNullable<IrRecordShape["tuple"]>);
  const f3 = r.tag(2, "IrModule.records[].indexValue") === 0 ? undefined : decIrType(r);
  const f4 = r.tag(2, "IrModule.records[].freezable") === 0 ? undefined : (r.bool() as NonNullable<IrRecordShape["freezable"]>);
  const f5 = r.tag(2, "IrModule.records[].declaredOrder") === 0 ? undefined : decT8(r);
  const f6 = r.tag(2, "IrModule.records[].accessorOrder") === 0 ? undefined : decT8(r);
  const f7 = r.tag(2, "IrModule.records[].orderVariants") === 0 ? undefined : decT47(r);
  const o: IrRecordShape = { id: f0, fields: f1, ...(f2 !== undefined ? { tuple: f2 } : {}), ...(f3 !== undefined ? { indexValue: f3 } : {}), ...(f4 !== undefined ? { freezable: f4 } : {}), ...(f5 !== undefined ? { declaredOrder: f5 } : {}), ...(f6 !== undefined ? { accessorOrder: f6 } : {}), ...(f7 !== undefined ? { orderVariants: f7 } : {}) };
  return o;
}

function encIrUnionDef(w: IrWriter, v: IrUnionDef): void {
  w.keys(Object.keys(v), KEYS59);
  w.str(v.id);
  encT38(w, v.arms);
  if (v.discriminant === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrUnionDiscriminant(w, v.discriminant);
  }
}
function decIrUnionDef(r: IrReader): IrUnionDef {
  const f0 = r.str();
  const f1 = decT38(r);
  const f2 = r.tag(2, "IrModule.unions[].discriminant") === 0 ? undefined : decIrUnionDiscriminant(r);
  const o: IrUnionDef = { id: f0, arms: f1, ...(f2 !== undefined ? { discriminant: f2 } : {}) };
  return o;
}

function encT27(w: IrWriter, v: NonNullable<NonNullable<IrModule["inferredFactFiles"]>[number]>): void {
  w.keys(Object.keys(v), KEYS60);
  w.file(v.file);
  w.str(v.pkg);
}
function decT27(r: IrReader): NonNullable<NonNullable<IrModule["inferredFactFiles"]>[number]> {
  const f0 = r.str();
  const f1 = r.str();
  const o: NonNullable<NonNullable<IrModule["inferredFactFiles"]>[number]> = { file: f0, pkg: f1 };
  return o;
}

function encIrRecordLink(w: IrWriter, v: IrRecordLink): void {
  w.keys(Object.keys(v), KEYS61);
  w.num(v.pair);
  w.str(v.from);
  w.str(v.to);
  w.str(v.compose);
}
function decIrRecordLink(r: IrReader): IrRecordLink {
  const f0 = r.num();
  const f1 = r.str();
  const f2 = r.str();
  const f3 = r.str();
  const o: IrRecordLink = { pair: f0, from: f1, to: f2, compose: f3 };
  return o;
}

function encIrNodeIslandModules(w: IrWriter, v: IrNodeIslandModules): void {
  w.keys(Object.keys(v), KEYS62);
  w.str(v.root);
  encT49(w, v.files);
  encT50(w, v.links);
  if (v.location === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.location);
  }
}
function decIrNodeIslandModules(r: IrReader): IrNodeIslandModules {
  const f0 = r.str();
  const f1 = decT49(r);
  const f2 = decT50(r);
  const f3 = r.tag(2, "IrModule.nodeIsland.modules.location") === 0 ? undefined : r.str();
  const o: IrNodeIslandModules = { root: f0, files: f1, links: f2, ...(f3 !== undefined ? { location: f3 } : {}) };
  return o;
}

function encIrFfiImport(w: IrWriter, v: IrFfiImport): void {
  w.keys(Object.keys(v), KEYS63);
  w.str(v.name);
  w.str(v.symbol);
  if (v.library === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.library);
  }
  if (v.callbackOperation === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.callbackOperation);
  }
  if (v.callbackTarget === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.callbackTarget);
  }
  encT51(w, v.params);
  w.str(v.returns);
}
function decIrFfiImport(r: IrReader): IrFfiImport {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = r.tag(2, "IrModule.ffiImports[].library") === 0 ? undefined : r.str();
  const f3 = r.tag(2, "IrModule.ffiImports[].callbackOperation") === 0 ? undefined : (r.str() as NonNullable<IrFfiImport["callbackOperation"]>);
  const f4 = r.tag(2, "IrModule.ffiImports[].callbackTarget") === 0 ? undefined : r.str();
  const f5 = decT51(r);
  const f6 = (r.str() as NonNullable<IrFfiImport["returns"]>);
  const o: IrFfiImport = { name: f0, symbol: f1, ...(f2 !== undefined ? { library: f2 } : {}), ...(f3 !== undefined ? { callbackOperation: f3 } : {}), ...(f4 !== undefined ? { callbackTarget: f4 } : {}), params: f5, returns: f6 };
  return o;
}

function encT31(w: IrWriter, v: NonNullable<IrLibSection["callbacks"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrLibCallback(w, item);
  }
}
function decT31(r: IrReader): NonNullable<IrLibSection["callbacks"]> {
  const length = r.length();
  const out: NonNullable<IrLibSection["callbacks"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrLibCallback(r));
  return out;
}

function encT32(w: IrWriter, v: NonNullable<IrLibSection["exports"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrLibExport(w, item);
  }
}
function decT32(r: IrReader): NonNullable<IrLibSection["exports"]> {
  const length = r.length();
  const out: NonNullable<IrLibSection["exports"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrLibExport(r));
  return out;
}

function encT33(w: IrWriter, v: NonNullable<IrLibSection["trapOverlays"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrLibTrapOverlay(w, item);
  }
}
function decT33(r: IrReader): NonNullable<IrLibSection["trapOverlays"]> {
  const length = r.length();
  const out: NonNullable<IrLibSection["trapOverlays"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrLibTrapOverlay(r));
  return out;
}

function encIrLibIdentity(w: IrWriter, v: IrLibIdentity): void {
  w.keys(Object.keys(v), KEYS64);
  w.str(v.buildIdSymbol);
  w.str(v.abiVersionSymbol);
  w.str(v.buildId);
  w.num(v.abiVersion);
}
function decIrLibIdentity(r: IrReader): IrLibIdentity {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = r.str();
  const f3 = r.num();
  const o: IrLibIdentity = { buildIdSymbol: f0, abiVersionSymbol: f1, buildId: f2, abiVersion: f3 };
  return o;
}

function encIrWasmModule(w: IrWriter, v: IrWasmModule): void {
  w.keys(Object.keys(v), KEYS65);
  w.str(v.sha256);
  w.str(v.bytes);
}
function decIrWasmModule(r: IrReader): IrWasmModule {
  const f0 = r.str();
  const f1 = r.str();
  const o: IrWasmModule = { sha256: f0, bytes: f1 };
  return o;
}

function encIrWasmUntranslated(w: IrWriter, v: IrWasmUntranslated): void {
  w.keys(Object.keys(v), KEYS66);
  w.str(v.sha256);
  w.num(v.size);
  w.str(v.reason);
}
function decIrWasmUntranslated(r: IrReader): IrWasmUntranslated {
  const f0 = r.str();
  const f1 = r.num();
  const f2 = r.str();
  const o: IrWasmUntranslated = { sha256: f0, size: f1, reason: f2 };
  return o;
}

function encIrParam(w: IrWriter, v: IrParam): void {
  w.keys(Object.keys(v), KEYS67);
  w.str(v.localId);
  w.str(v.name);
  encIrType(w, v.type);
  if (v.owned === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.owned);
  }
}
function decIrParam(r: IrReader): IrParam {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = decIrType(r);
  const f3 = r.tag(2, "IrFunction.params[].owned") === 0 ? undefined : (r.bool() as NonNullable<IrParam["owned"]>);
  const o: IrParam = { localId: f0, name: f1, type: f2, ...(f3 !== undefined ? { owned: f3 } : {}) };
  return o;
}

function encT38(w: IrWriter, v: NonNullable<Extract<IrType, { kind: "func" }>["params"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrType(w, item);
  }
}
function decT38(r: IrReader): NonNullable<Extract<IrType, { kind: "func" }>["params"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrType, { kind: "func" }>["params"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrType(r));
  return out;
}

function encIrLocal(w: IrWriter, v: IrLocal): void {
  w.keys(Object.keys(v), KEYS68);
  w.str(v.id);
  w.str(v.name);
  encIrType(w, v.type);
  w.bool(v.mutable);
  if (v.source === undefined) w.byte(0);
  else {
    w.byte(1);
    encIrBindingSource(w, v.source);
  }
  if (v.boxed === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.boxed);
  }
  if (v.tdz === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.tdz);
  }
}
function decIrLocal(r: IrReader): IrLocal {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = decIrType(r);
  const f3 = r.bool();
  const f4 = r.tag(2, "IrFunction.locals[].source") === 0 ? undefined : decIrBindingSource(r);
  const f5 = r.tag(2, "IrFunction.locals[].boxed") === 0 ? undefined : (r.bool() as NonNullable<IrLocal["boxed"]>);
  const f6 = r.tag(2, "IrFunction.locals[].tdz") === 0 ? undefined : (r.bool() as NonNullable<IrLocal["tdz"]>);
  const o: IrLocal = { id: f0, name: f1, type: f2, mutable: f3, ...(f4 !== undefined ? { source: f4 } : {}), ...(f5 !== undefined ? { boxed: f5 } : {}), ...(f6 !== undefined ? { tdz: f6 } : {}) };
  return o;
}

function encT40(w: IrWriter, v: NonNullable<NonNullable<IrFunction["classCaptures"]>[number]>): void {
  w.keys(Object.keys(v), KEYS69);
  w.str(v.localId);
  w.str(v.name);
  encIrType(w, v.type);
  if (v.owned === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.owned);
  }
  w.num(v.slot);
}
function decT40(r: IrReader): NonNullable<NonNullable<IrFunction["classCaptures"]>[number]> {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = decIrType(r);
  const f3 = r.tag(2, "IrFunction.classCaptures[].owned") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<NonNullable<IrFunction["classCaptures"]>[number]>["owned"]>);
  const f4 = r.num();
  const o: NonNullable<NonNullable<IrFunction["classCaptures"]>[number]> = { localId: f0, name: f1, type: f2, ...(f3 !== undefined ? { owned: f3 } : {}), slot: f4 };
  return o;
}

function encIrStmt(w: IrWriter, v: IrStmt): void {
  switch (v.kind) {
    case "arrayDelete": {
      w.length(0);
      w.keys(Object.keys(v), KEYS70);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arraySet": {
      w.length(1);
      w.keys(Object.keys(v), KEYS71);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encIrExpr(w, v.value);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arraySetLength": {
      w.length(2);
      w.keys(Object.keys(v), KEYS72);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.length);
      encSrcLoc(w, v.loc);
      if (v.pop === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.pop);
      }
      if (v.reserve === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.reserve);
      }
      return;
    }
    case "arraySetUndefined": {
      w.length(3);
      w.keys(Object.keys(v), KEYS73);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encSrcLoc(w, v.loc);
      return;
    }
    case "assign": {
      w.length(4);
      w.keys(Object.keys(v), KEYS74);
      w.str(v.localId);
      encIrExpr(w, v.value);
      if (v.initializes === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.initializes);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "block": {
      w.length(5);
      w.keys(Object.keys(v), KEYS75);
      if (v.labels === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.labels);
      }
      encT20(w, v.body);
      encSrcLoc(w, v.loc);
      return;
    }
    case "break": {
      w.length(6);
      w.keys(Object.keys(v), KEYS76);
      if (v.label === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.label);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "bytesSet": {
      w.length(7);
      w.keys(Object.keys(v), KEYS77);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encIrExpr(w, v.value);
      encSrcLoc(w, v.loc);
      return;
    }
    case "continue": {
      w.length(8);
      w.keys(Object.keys(v), KEYS78);
      if (v.label === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.label);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "doWhile": {
      w.length(9);
      w.keys(Object.keys(v), KEYS79);
      encT20(w, v.body);
      encIrExpr(w, v.cond);
      if (v.labels === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.labels);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "exprStmt": {
      w.length(10);
      w.keys(Object.keys(v), KEYS80);
      encIrExpr(w, v.expr);
      encSrcLoc(w, v.loc);
      return;
    }
    case "fieldSet": {
      w.length(11);
      w.keys(Object.keys(v), KEYS81);
      encIrExpr(w, v.obj);
      w.str(v.className);
      w.str(v.field);
      encIrExpr(w, v.value);
      if (v.sloppy === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.sloppy);
      }
      if (v.define === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.define);
      }
      if (v.attributesChecked === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.attributesChecked);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "for": {
      w.length(12);
      w.keys(Object.keys(v), KEYS82);
      if (v.init === null) w.byte(0);
      else {
        w.byte(1);
        encIrStmt(w, v.init);
      }
      if (v.cond === null) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.cond);
      }
      if (v.update === null) w.byte(0);
      else {
        w.byte(1);
        encIrStmt(w, v.update);
      }
      encT20(w, v.body);
      if (v.labels === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.labels);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "forOf": {
      w.length(13);
      w.keys(Object.keys(v), KEYS83);
      w.str(v.localId);
      encIrExpr(w, v.iterable);
      encT20(w, v.body);
      if (v.labels === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.labels);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "genBindBarrier": {
      w.length(14);
      w.keys(Object.keys(v), KEYS84);
      encSrcLoc(w, v.loc);
      return;
    }
    case "if": {
      w.length(15);
      w.keys(Object.keys(v), KEYS85);
      encIrExpr(w, v.cond);
      encT20(w, v.then);
      if (v.else_ === null) w.byte(0);
      else {
        w.byte(1);
        encT20(w, v.else_);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordKeyDelete": {
      w.length(16);
      w.keys(Object.keys(v), KEYS86);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      encIrExpr(w, v.key);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordKeySet": {
      w.length(17);
      w.keys(Object.keys(v), KEYS87);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      encIrExpr(w, v.key);
      encIrExpr(w, v.value);
      if (v.overflowOnly === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.overflowOnly);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordSet": {
      w.length(18);
      w.keys(Object.keys(v), KEYS88);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      w.str(v.field);
      encIrExpr(w, v.value);
      encSrcLoc(w, v.loc);
      return;
    }
    case "rethrow": {
      w.length(19);
      w.keys(Object.keys(v), KEYS89);
      w.str(v.localId);
      encSrcLoc(w, v.loc);
      return;
    }
    case "return": {
      w.length(20);
      w.keys(Object.keys(v), KEYS90);
      if (v.value === null) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.value);
      }
      if (v.awaited === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.awaited);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "runtimeFence": {
      w.length(21);
      w.keys(Object.keys(v), KEYS91);
      w.str(v.code);
      w.str(v.message);
      encSrcLoc(w, v.loc);
      return;
    }
    case "switch": {
      w.length(22);
      w.keys(Object.keys(v), KEYS92);
      encIrExpr(w, v.disc);
      encT56(w, v.cases);
      if (v.labels === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.labels);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "throw": {
      w.length(23);
      w.keys(Object.keys(v), KEYS93);
      encIrExpr(w, v.value);
      encSrcLoc(w, v.loc);
      return;
    }
    case "tryCatch": {
      w.length(24);
      w.keys(Object.keys(v), KEYS94);
      encT20(w, v.tryBody);
      if (v.catchBody === null) w.byte(0);
      else {
        w.byte(1);
        encT20(w, v.catchBody);
      }
      if (v.catchLocalId === null) w.byte(0);
      else {
        w.byte(1);
        w.str(v.catchLocalId);
      }
      if (v.dropFinallyErrors === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.dropFinallyErrors);
      }
      if (v.finallyBody === null) w.byte(0);
      else {
        w.byte(1);
        encT20(w, v.finallyBody);
      }
      if (v.suppressFinallyErrors === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.suppressFinallyErrors);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "varDecl": {
      w.length(25);
      w.keys(Object.keys(v), KEYS95);
      w.str(v.localId);
      if (v.init === null) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.init);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "while": {
      w.length(26);
      w.keys(Object.keys(v), KEYS96);
      encIrExpr(w, v.cond);
      encT20(w, v.body);
      if (v.labels === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.labels);
      }
      encSrcLoc(w, v.loc);
      return;
    }
  }
  w.refuse("IrStmt kind " + String((v as { kind: unknown }).kind));
}
function decIrStmt(r: IrReader): IrStmt {
  switch (r.length()) {
    case 0: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "arrayDelete" }> = { kind: "arrayDelete", arr: f0, index: f1, loc: f2 };
      return o;
    }
    case 1: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "arraySet" }> = { kind: "arraySet", arr: f0, index: f1, value: f2, loc: f3 };
      return o;
    }
    case 2: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decSrcLoc(r);
      const f3 = r.tag(2, "IrFunction.body[]<arraySetLength>.pop") === 0 ? undefined : r.bool();
      const f4 = r.tag(2, "IrFunction.body[]<arraySetLength>.reserve") === 0 ? undefined : r.bool();
      const o: Extract<IrStmt, { kind: "arraySetLength" }> = { kind: "arraySetLength", arr: f0, length: f1, loc: f2, ...(f3 !== undefined ? { pop: f3 } : {}), ...(f4 !== undefined ? { reserve: f4 } : {}) };
      return o;
    }
    case 3: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "arraySetUndefined" }> = { kind: "arraySetUndefined", arr: f0, index: f1, loc: f2 };
      return o;
    }
    case 4: {
      const f0 = r.str();
      const f1 = decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<assign>.initializes") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "assign" }>["initializes"]>);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "assign" }> = { kind: "assign", localId: f0, value: f1, ...(f2 !== undefined ? { initializes: f2 } : {}), loc: f3 };
      return o;
    }
    case 5: {
      const f0 = r.tag(2, "IrFunction.body[]<block>.labels") === 0 ? undefined : decT8(r);
      const f1 = decT20(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "block" }> = { kind: "block", ...(f0 !== undefined ? { labels: f0 } : {}), body: f1, loc: f2 };
      return o;
    }
    case 6: {
      const f0 = r.tag(2, "IrFunction.body[]<break>.label") === 0 ? undefined : r.str();
      const f1 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "break" }> = { kind: "break", ...(f0 !== undefined ? { label: f0 } : {}), loc: f1 };
      return o;
    }
    case 7: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "bytesSet" }> = { kind: "bytesSet", arr: f0, index: f1, value: f2, loc: f3 };
      return o;
    }
    case 8: {
      const f0 = r.tag(2, "IrFunction.body[]<continue>.label") === 0 ? undefined : r.str();
      const f1 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "continue" }> = { kind: "continue", ...(f0 !== undefined ? { label: f0 } : {}), loc: f1 };
      return o;
    }
    case 9: {
      const f0 = decT20(r);
      const f1 = decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<doWhile>.labels") === 0 ? undefined : decT8(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "doWhile" }> = { kind: "doWhile", body: f0, cond: f1, ...(f2 !== undefined ? { labels: f2 } : {}), loc: f3 };
      return o;
    }
    case 10: {
      const f0 = decIrExpr(r);
      const f1 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "exprStmt" }> = { kind: "exprStmt", expr: f0, loc: f1 };
      return o;
    }
    case 11: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.str();
      const f3 = decIrExpr(r);
      const f4 = r.tag(2, "IrFunction.body[]<fieldSet>.sloppy") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "fieldSet" }>["sloppy"]>);
      const f5 = r.tag(2, "IrFunction.body[]<fieldSet>.define") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "fieldSet" }>["define"]>);
      const f6 = r.tag(2, "IrFunction.body[]<fieldSet>.attributesChecked") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "fieldSet" }>["attributesChecked"]>);
      const f7 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "fieldSet" }> = { kind: "fieldSet", obj: f0, className: f1, field: f2, value: f3, ...(f4 !== undefined ? { sloppy: f4 } : {}), ...(f5 !== undefined ? { define: f5 } : {}), ...(f6 !== undefined ? { attributesChecked: f6 } : {}), loc: f7 };
      return o;
    }
    case 12: {
      const f0 = r.tag(2, "IrFunction.body[]<for>.init") === 0 ? null : decIrStmt(r);
      const f1 = r.tag(2, "IrFunction.body[]<for>.cond") === 0 ? null : decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<for>.update") === 0 ? null : decIrStmt(r);
      const f3 = decT20(r);
      const f4 = r.tag(2, "IrFunction.body[]<for>.labels") === 0 ? undefined : decT8(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "for" }> = { kind: "for", init: f0, cond: f1, update: f2, body: f3, ...(f4 !== undefined ? { labels: f4 } : {}), loc: f5 };
      return o;
    }
    case 13: {
      const f0 = r.str();
      const f1 = decIrExpr(r);
      const f2 = decT20(r);
      const f3 = r.tag(2, "IrFunction.body[]<forOf>.labels") === 0 ? undefined : decT8(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "forOf" }> = { kind: "forOf", localId: f0, iterable: f1, body: f2, ...(f3 !== undefined ? { labels: f3 } : {}), loc: f4 };
      return o;
    }
    case 14: {
      const f0 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "genBindBarrier" }> = { kind: "genBindBarrier", loc: f0 };
      return o;
    }
    case 15: {
      const f0 = decIrExpr(r);
      const f1 = decT20(r);
      const f2 = r.tag(2, "IrFunction.body[]<if>.else_") === 0 ? null : decT20(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "if" }> = { kind: "if", cond: f0, then: f1, else_: f2, loc: f3 };
      return o;
    }
    case 16: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrExpr(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "recordKeyDelete" }> = { kind: "recordKeyDelete", obj: f0, shapeId: f1, key: f2, loc: f3 };
      return o;
    }
    case 17: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrExpr(r);
      const f3 = decIrExpr(r);
      const f4 = r.tag(2, "IrFunction.body[]<recordKeySet>.overflowOnly") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "recordKeySet" }>["overflowOnly"]>);
      const f5 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "recordKeySet" }> = { kind: "recordKeySet", obj: f0, shapeId: f1, key: f2, value: f3, ...(f4 !== undefined ? { overflowOnly: f4 } : {}), loc: f5 };
      return o;
    }
    case 18: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.str();
      const f3 = decIrExpr(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "recordSet" }> = { kind: "recordSet", obj: f0, shapeId: f1, field: f2, value: f3, loc: f4 };
      return o;
    }
    case 19: {
      const f0 = r.str();
      const f1 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "rethrow" }> = { kind: "rethrow", localId: f0, loc: f1 };
      return o;
    }
    case 20: {
      const f0 = r.tag(2, "IrFunction.body[]<return>.value") === 0 ? null : decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<return>.awaited") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "return" }>["awaited"]>);
      const f2 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "return" }> = { kind: "return", value: f0, ...(f1 !== undefined ? { awaited: f1 } : {}), loc: f2 };
      return o;
    }
    case 21: {
      const f0 = r.str();
      const f1 = r.str();
      const f2 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "runtimeFence" }> = { kind: "runtimeFence", code: f0, message: f1, loc: f2 };
      return o;
    }
    case 22: {
      const f0 = decIrExpr(r);
      const f1 = decT56(r);
      const f2 = r.tag(2, "IrFunction.body[]<switch>.labels") === 0 ? undefined : decT8(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "switch" }> = { kind: "switch", disc: f0, cases: f1, ...(f2 !== undefined ? { labels: f2 } : {}), loc: f3 };
      return o;
    }
    case 23: {
      const f0 = decIrExpr(r);
      const f1 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "throw" }> = { kind: "throw", value: f0, loc: f1 };
      return o;
    }
    case 24: {
      const f0 = decT20(r);
      const f1 = r.tag(2, "IrFunction.body[]<tryCatch>.catchBody") === 0 ? null : decT20(r);
      const f2 = r.tag(2, "IrFunction.body[]<tryCatch>.catchLocalId") === 0 ? null : r.str();
      const f3 = r.tag(2, "IrFunction.body[]<tryCatch>.dropFinallyErrors") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "tryCatch" }>["dropFinallyErrors"]>);
      const f4 = r.tag(2, "IrFunction.body[]<tryCatch>.finallyBody") === 0 ? null : decT20(r);
      const f5 = r.tag(2, "IrFunction.body[]<tryCatch>.suppressFinallyErrors") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrStmt, { kind: "tryCatch" }>["suppressFinallyErrors"]>);
      const f6 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "tryCatch" }> = { kind: "tryCatch", tryBody: f0, catchBody: f1, catchLocalId: f2, ...(f3 !== undefined ? { dropFinallyErrors: f3 } : {}), finallyBody: f4, ...(f5 !== undefined ? { suppressFinallyErrors: f5 } : {}), loc: f6 };
      return o;
    }
    case 25: {
      const f0 = r.str();
      const f1 = r.tag(2, "IrFunction.body[]<varDecl>.init") === 0 ? null : decIrExpr(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "varDecl" }> = { kind: "varDecl", localId: f0, init: f1, loc: f2 };
      return o;
    }
    case 26: {
      const f0 = decIrExpr(r);
      const f1 = decT20(r);
      const f2 = r.tag(2, "IrFunction.body[]<while>.labels") === 0 ? undefined : decT8(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrStmt, { kind: "while" }> = { kind: "while", cond: f0, body: f1, ...(f2 !== undefined ? { labels: f2 } : {}), loc: f3 };
      return o;
    }
  }
  throw new Error("IR codec: invalid IrStmt kind");
}

function encT42(w: IrWriter, v: NonNullable<NonNullable<IrFunction["generator"]>["resultType"]>): void {
  w.keys(Object.keys(v), KEYS97);
  w.str(v.kind);
  w.str(v.shapeId);
}
function decT42(r: IrReader): NonNullable<NonNullable<IrFunction["generator"]>["resultType"]> {
  const f0 = (r.str() as NonNullable<NonNullable<NonNullable<IrFunction["generator"]>["resultType"]>["kind"]>);
  const f1 = r.str();
  const o: NonNullable<NonNullable<IrFunction["generator"]>["resultType"]> = { kind: f0, shapeId: f1 };
  return o;
}

function encT43(w: IrWriter, v: NonNullable<IrClassDef["symbolFields"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT57(w, item);
  }
}
function decT43(r: IrReader): NonNullable<IrClassDef["symbolFields"]> {
  const length = r.length();
  const out: NonNullable<IrClassDef["symbolFields"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT57(r));
  return out;
}

function encT44(w: IrWriter, v: NonNullable<IrClassDef["fields"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT58(w, item);
  }
}
function decT44(r: IrReader): NonNullable<IrClassDef["fields"]> {
  const length = r.length();
  const out: NonNullable<IrClassDef["fields"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT58(r));
  return out;
}

function encIrBindingSource(w: IrWriter, v: IrBindingSource): void {
  w.keys(Object.keys(v), KEYS98);
  encSrcLoc(w, v.loc);
  encSrcLoc(w, v.scope);
}
function decIrBindingSource(r: IrReader): IrBindingSource {
  const f0 = decSrcLoc(r);
  const f1 = decSrcLoc(r);
  const o: IrBindingSource = { loc: f0, scope: f1 };
  return o;
}

function encT46(w: IrWriter, v: NonNullable<IrRecordShape["fields"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT59(w, item);
  }
}
function decT46(r: IrReader): NonNullable<IrRecordShape["fields"]> {
  const length = r.length();
  const out: NonNullable<IrRecordShape["fields"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT59(r));
  return out;
}

function encT47(w: IrWriter, v: NonNullable<IrRecordShape["orderVariants"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT8(w, item);
  }
}
function decT47(r: IrReader): NonNullable<IrRecordShape["orderVariants"]> {
  const length = r.length();
  const out: NonNullable<IrRecordShape["orderVariants"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT8(r));
  return out;
}

function encIrUnionDiscriminant(w: IrWriter, v: IrUnionDiscriminant): void {
  w.keys(Object.keys(v), KEYS99);
  w.str(v.field);
  encT60(w, v.cases);
}
function decIrUnionDiscriminant(r: IrReader): IrUnionDiscriminant {
  const f0 = r.str();
  const f1 = decT60(r);
  const o: IrUnionDiscriminant = { field: f0, cases: f1 };
  return o;
}

function encT49(w: IrWriter, v: NonNullable<IrNodeIslandModules["files"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT61(w, item);
  }
}
function decT49(r: IrReader): NonNullable<IrNodeIslandModules["files"]> {
  const length = r.length();
  const out: NonNullable<IrNodeIslandModules["files"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT61(r));
  return out;
}

function encT50(w: IrWriter, v: NonNullable<IrNodeIslandModules["links"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT62(w, item);
  }
}
function decT50(r: IrReader): NonNullable<IrNodeIslandModules["links"]> {
  const length = r.length();
  const out: NonNullable<IrNodeIslandModules["links"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT62(r));
  return out;
}

function encT51(w: IrWriter, v: NonNullable<IrFfiImport["params"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrFfiParam(w, item);
  }
}
function decT51(r: IrReader): NonNullable<IrFfiImport["params"]> {
  const length = r.length();
  const out: NonNullable<IrFfiImport["params"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrFfiParam(r));
  return out;
}

function encIrLibCallback(w: IrWriter, v: IrLibCallback): void {
  w.keys(Object.keys(v), KEYS100);
  w.str(v.name);
  w.num(v.slot);
  encT64(w, v.params);
  w.str(v.returns);
  w.str(v.unregisteredTrap);
}
function decIrLibCallback(r: IrReader): IrLibCallback {
  const f0 = r.str();
  const f1 = r.num();
  const f2 = decT64(r);
  const f3 = (r.str() as NonNullable<IrLibCallback["returns"]>);
  const f4 = r.str();
  const o: IrLibCallback = { name: f0, slot: f1, params: f2, returns: f3, unregisteredTrap: f4 };
  return o;
}

function encIrLibExport(w: IrWriter, v: IrLibExport): void {
  w.keys(Object.keys(v), KEYS101);
  w.str(v.symbol);
  w.str(v.fnName);
  encT65(w, v.params);
  w.str(v.returns);
  if (v.inboundBytesTrap === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.inboundBytesTrap);
  }
  if (v.inboundIntTrap === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.inboundIntTrap);
  }
  if (v.inboundCstringTrap === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.inboundCstringTrap);
  }
}
function decIrLibExport(r: IrReader): IrLibExport {
  const f0 = r.str();
  const f1 = r.str();
  const f2 = decT65(r);
  const f3 = (r.str() as NonNullable<IrLibExport["returns"]>);
  const f4 = r.tag(2, "IrModule.lib.exports[].inboundBytesTrap") === 0 ? undefined : r.str();
  const f5 = r.tag(2, "IrModule.lib.exports[].inboundIntTrap") === 0 ? undefined : r.str();
  const f6 = r.tag(2, "IrModule.lib.exports[].inboundCstringTrap") === 0 ? undefined : r.str();
  const o: IrLibExport = { symbol: f0, fnName: f1, params: f2, returns: f3, ...(f4 !== undefined ? { inboundBytesTrap: f4 } : {}), ...(f5 !== undefined ? { inboundIntTrap: f5 } : {}), ...(f6 !== undefined ? { inboundCstringTrap: f6 } : {}) };
  return o;
}

function encIrLibTrapOverlay(w: IrWriter, v: IrLibTrapOverlay): void {
  w.keys(Object.keys(v), KEYS102);
  w.str(v.code);
  if (v.teaching === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.teaching);
  }
  if (v.remediation === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.remediation);
  }
}
function decIrLibTrapOverlay(r: IrReader): IrLibTrapOverlay {
  const f0 = r.str();
  const f1 = r.tag(2, "IrModule.lib.trapOverlays[].teaching") === 0 ? undefined : r.str();
  const f2 = r.tag(2, "IrModule.lib.trapOverlays[].remediation") === 0 ? undefined : r.str();
  const o: IrLibTrapOverlay = { code: f0, ...(f1 !== undefined ? { teaching: f1 } : {}), ...(f2 !== undefined ? { remediation: f2 } : {}) };
  return o;
}

function encIrExpr(w: IrWriter, v: IrExpr): void {
  switch (v.kind) {
    case "arrIntrinsic": {
      w.length(0);
      w.keys(Object.keys(v), KEYS103);
      w.str(v.method);
      encIrExpr(w, v.receiver);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arrayGet": {
      w.length(1);
      w.keys(Object.keys(v), KEYS104);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arrayHas": {
      w.length(2);
      w.keys(Object.keys(v), KEYS105);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arrayLit": {
      w.length(3);
      w.keys(Object.keys(v), KEYS106);
      encT66(w, v.elems);
      if (v.spreads === undefined) w.byte(0);
      else {
        w.byte(1);
        encT67(w, v.spreads);
      }
      if (v.capacity === undefined) w.byte(0);
      else {
        w.byte(1);
        w.num(v.capacity);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arrayNewLen": {
      w.length(4);
      w.keys(Object.keys(v), KEYS107);
      encIrExpr(w, v.length);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "arrayState": {
      w.length(5);
      w.keys(Object.keys(v), KEYS108);
      encIrExpr(w, v.arr);
      encIrExpr(w, v.index);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "assignExpr": {
      w.length(6);
      w.keys(Object.keys(v), KEYS109);
      w.str(v.localId);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "awaitExpr": {
      w.length(7);
      w.keys(Object.keys(v), KEYS110);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      if (v.adopt === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.adopt);
      }
      encSrcLoc(w, v.loc);
      return;
    }
    case "awaitUnionExpr": {
      w.length(8);
      w.keys(Object.keys(v), KEYS111);
      encIrExpr(w, v.value);
      w.num(v.promiseTag);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "bin": {
      w.length(9);
      w.keys(Object.keys(v), KEYS112);
      w.str(v.op);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "boolLit": {
      w.length(10);
      w.keys(Object.keys(v), KEYS113);
      w.bool(v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "bytesIntrinsic": {
      w.length(11);
      w.keys(Object.keys(v), KEYS114);
      w.str(v.method);
      encIrExpr(w, v.receiver);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      if (v.invalidNaN === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.invalidNaN);
      }
      return;
    }
    case "bytesNew": {
      w.length(12);
      w.keys(Object.keys(v), KEYS115);
      if (v.source === null) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.source);
      }
      if (v.from === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.from);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "call": {
      w.length(13);
      w.keys(Object.keys(v), KEYS116);
      w.str(v.callee);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "callValue": {
      w.length(14);
      w.keys(Object.keys(v), KEYS117);
      encIrExpr(w, v.callee);
      if (v.receiver === undefined) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.receiver);
      }
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "caughtCheck": {
      w.length(15);
      w.keys(Object.keys(v), KEYS118);
      encIrExpr(w, v.value);
      w.str(v.className);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "caughtNarrow": {
      w.length(16);
      w.keys(Object.keys(v), KEYS119);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "caughtTest": {
      w.length(17);
      w.keys(Object.keys(v), KEYS120);
      encIrExpr(w, v.value);
      w.str(v.test);
      if (v.className === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.className);
      }
      if (v.negated === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.negated);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "caughtToDyn": {
      w.length(18);
      w.keys(Object.keys(v), KEYS121);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "chainRecv": {
      w.length(19);
      w.keys(Object.keys(v), KEYS122);
      w.str(v.id);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "classRef": {
      w.length(20);
      w.keys(Object.keys(v), KEYS123);
      w.str(v.className);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      if (v.captures === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.captures);
      }
      return;
    }
    case "closure": {
      w.length(21);
      w.keys(Object.keys(v), KEYS124);
      w.str(v.fnName);
      encT8(w, v.captures);
      if (v.adapts === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.adapts);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "downcast": {
      w.length(22);
      w.keys(Object.keys(v), KEYS125);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynArrLit": {
      w.length(23);
      w.keys(Object.keys(v), KEYS126);
      encT66(w, v.elems);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynCall": {
      w.length(24);
      w.keys(Object.keys(v), KEYS127);
      encIrExpr(w, v.callee);
      if (v.receiver === undefined) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.receiver);
      }
      w.str(v.calleeName);
      if (v.calleeNameValue === undefined) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.calleeNameValue);
      }
      encT66(w, v.args);
      if (v.spreads === undefined) w.byte(0);
      else {
        w.byte(1);
        encT68(w, v.spreads);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynCheck": {
      w.length(25);
      w.keys(Object.keys(v), KEYS128);
      encIrExpr(w, v.value);
      if (v.preserveRefs === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.preserveRefs);
      }
      if (v.adopt === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.adopt);
      }
      if (v.exact === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.exact);
      }
      if (v.partialView === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.partialView);
      }
      if (v.inferredSite === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.inferredSite);
      }
      if (v.origin === undefined) w.byte(0);
      else {
        w.byte(1);
        w.num(v.origin);
      }
      if (v.pathIndex === undefined) w.byte(0);
      else {
        w.byte(1);
        w.num(v.pathIndex);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynDestrCheck": {
      w.length(26);
      w.keys(Object.keys(v), KEYS129);
      encIrExpr(w, v.value);
      w.str(v.spelling);
      if (v.firstProp === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.firstProp);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynFrom": {
      w.length(27);
      w.keys(Object.keys(v), KEYS130);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      if (v.liveRef === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.liveRef);
      }
      if (v.fnName === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.fnName);
      }
      if (v.fnLength === undefined) w.byte(0);
      else {
        w.byte(1);
        w.num(v.fnLength);
      }
      return;
    }
    case "dynHasKey": {
      w.length(28);
      w.keys(Object.keys(v), KEYS131);
      w.str(v.key);
      if (v.negated === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.negated);
      }
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynInvoke": {
      w.length(29);
      w.keys(Object.keys(v), KEYS132);
      encIrExpr(w, v.recv);
      w.str(v.method);
      w.str(v.calleeName);
      if (v.calleeNameValue === undefined) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.calleeNameValue);
      }
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynIterN": {
      w.length(30);
      w.keys(Object.keys(v), KEYS133);
      encIrExpr(w, v.value);
      w.num(v.count);
      if (v.notIterableMessage === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.notIterableMessage);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynKeyGet": {
      w.length(31);
      w.keys(Object.keys(v), KEYS134);
      encIrExpr(w, v.key);
      if (v.optional === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.optional);
      }
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynObjLit": {
      w.length(32);
      w.keys(Object.keys(v), KEYS135);
      if (v.fields === undefined) w.byte(0);
      else {
        w.byte(1);
        encT69(w, v.fields);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynScalarEq": {
      w.length(33);
      w.keys(Object.keys(v), KEYS136);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      if (v.negated === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.negated);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "dynTest": {
      w.length(34);
      w.keys(Object.keys(v), KEYS137);
      w.str(v.test);
      if (v.bytesElem === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.bytesElem);
      }
      if (v.negated === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.negated);
      }
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "ffiCall": {
      w.length(35);
      w.keys(Object.keys(v), KEYS138);
      w.str(v.import);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "fieldAbsent": {
      w.length(36);
      w.keys(Object.keys(v), KEYS139);
      w.str(v.unionId);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "fieldGet": {
      w.length(37);
      w.keys(Object.keys(v), KEYS140);
      encIrExpr(w, v.obj);
      w.str(v.className);
      w.str(v.field);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "fieldIncDec": {
      w.length(38);
      w.keys(Object.keys(v), KEYS141);
      w.str(v.op);
      w.bool(v.prefix);
      encIrExpr(w, v.obj);
      w.str(v.className);
      w.str(v.field);
      w.bool(v.fieldDyn);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "genResume": {
      w.length(39);
      w.keys(Object.keys(v), KEYS142);
      w.str(v.mode);
      encIrExpr(w, v.gen);
      if (v.arg === null) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.arg);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "incDec": {
      w.length(40);
      w.keys(Object.keys(v), KEYS143);
      w.str(v.op);
      w.bool(v.prefix);
      w.str(v.localId);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "instanceOf": {
      w.length(41);
      w.keys(Object.keys(v), KEYS144);
      encIrExpr(w, v.value);
      w.str(v.className);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "instanceOfValue": {
      w.length(42);
      w.keys(Object.keys(v), KEYS145);
      encIrExpr(w, v.value);
      encIrExpr(w, v.classValue);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "intrinsic": {
      w.length(43);
      w.keys(Object.keys(v), KEYS146);
      w.str(v.name);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "jsonStringify": {
      w.length(44);
      w.keys(Object.keys(v), KEYS147);
      encIrExpr(w, v.value);
      if (v.indent === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.indent);
      }
      if (v.circular === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.circular);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "libCall": {
      w.length(45);
      w.keys(Object.keys(v), KEYS148);
      w.str(v.fn);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      if (v.prototypeIdentityOnly === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.prototypeIdentityOnly);
      }
      if (v.realTimer === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.realTimer);
      }
      if (v.assertOptions === undefined) w.byte(0);
      else {
        w.byte(1);
        encT70(w, v.assertOptions);
      }
      if (v.bindsThis === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.bindsThis);
      }
      return;
    }
    case "logical": {
      w.length(46);
      w.keys(Object.keys(v), KEYS149);
      w.str(v.op);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "mapIntrinsic": {
      w.length(47);
      w.keys(Object.keys(v), KEYS150);
      w.str(v.method);
      encIrExpr(w, v.receiver);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "mapNew": {
      w.length(48);
      w.keys(Object.keys(v), KEYS151);
      if (v.seed === undefined) w.byte(0);
      else {
        w.byte(1);
        encT71(w, v.seed);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "moduleNsRef": {
      w.length(49);
      w.keys(Object.keys(v), KEYS152);
      w.str(v.moduleId);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "new": {
      w.length(50);
      w.keys(Object.keys(v), KEYS153);
      w.str(v.className);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "newPromise": {
      w.length(51);
      w.keys(Object.keys(v), KEYS154);
      encIrExpr(w, v.executor);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "newValue": {
      w.length(52);
      w.keys(Object.keys(v), KEYS155);
      encIrExpr(w, v.callee);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "nullish": {
      w.length(53);
      w.keys(Object.keys(v), KEYS156);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "numLit": {
      w.length(54);
      w.keys(Object.keys(v), KEYS157);
      w.num(v.value);
      if (v.spelling === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.spelling);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "optChain": {
      w.length(55);
      w.keys(Object.keys(v), KEYS158);
      w.str(v.id);
      encIrExpr(w, v.receiver);
      encIrExpr(w, v.body);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "orDefault": {
      w.length(56);
      w.keys(Object.keys(v), KEYS159);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      if (v.retag === undefined) w.byte(0);
      else {
        w.byte(1);
        w.str(v.retag);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "promiseVoidWiden": {
      w.length(57);
      w.keys(Object.keys(v), KEYS160);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "promiseWithResolvers": {
      w.length(58);
      w.keys(Object.keys(v), KEYS161);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordClone": {
      w.length(59);
      w.keys(Object.keys(v), KEYS162);
      encIrExpr(w, v.source);
      encT72(w, v.overrides);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordGet": {
      w.length(60);
      w.keys(Object.keys(v), KEYS163);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      w.str(v.field);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordHas": {
      w.length(61);
      w.keys(Object.keys(v), KEYS164);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      w.str(v.field);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordKeyGet": {
      w.length(62);
      w.keys(Object.keys(v), KEYS165);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      encIrExpr(w, v.key);
      if (v.overflowOnly === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.overflowOnly);
      }
      if (v.missNaN === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.missNaN);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordLit": {
      w.length(63);
      w.keys(Object.keys(v), KEYS166);
      encT73(w, v.fields);
      if (v.nullProto === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.nullProto);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordNullProto": {
      w.length(64);
      w.keys(Object.keys(v), KEYS167);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordOvfHas": {
      w.length(65);
      w.keys(Object.keys(v), KEYS168);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      encIrExpr(w, v.key);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "recordOvfKeys": {
      w.length(66);
      w.keys(Object.keys(v), KEYS169);
      encIrExpr(w, v.obj);
      w.str(v.shapeId);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "regexIntrinsic": {
      w.length(67);
      w.keys(Object.keys(v), KEYS170);
      w.str(v.method);
      encIrExpr(w, v.receiver);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "regexLit": {
      w.length(68);
      w.keys(Object.keys(v), KEYS171);
      w.str(v.pattern);
      w.str(v.flags);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "selfRef": {
      w.length(69);
      w.keys(Object.keys(v), KEYS172);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "seqExpr": {
      w.length(70);
      w.keys(Object.keys(v), KEYS173);
      encT20(w, v.stmts);
      encIrExpr(w, v.result);
      if (v.generatorDelegate === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.generatorDelegate);
      }
      if (v.diverges === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.diverges);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "setIntrinsic": {
      w.length(71);
      w.keys(Object.keys(v), KEYS174);
      w.str(v.method);
      encIrExpr(w, v.receiver);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "setNew": {
      w.length(72);
      w.keys(Object.keys(v), KEYS175);
      if (v.seed === undefined) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.seed);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "strCmp": {
      w.length(73);
      w.keys(Object.keys(v), KEYS176);
      w.str(v.op);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "strConcat": {
      w.length(74);
      w.keys(Object.keys(v), KEYS177);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "strEq": {
      w.length(75);
      w.keys(Object.keys(v), KEYS178);
      w.bool(v.negated);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "strIntrinsic": {
      w.length(76);
      w.keys(Object.keys(v), KEYS179);
      w.str(v.method);
      encIrExpr(w, v.receiver);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "strLit": {
      w.length(77);
      w.keys(Object.keys(v), KEYS180);
      w.str(v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "templateStrings": {
      w.length(78);
      w.keys(Object.keys(v), KEYS181);
      w.str(v.key);
      encT8(w, v.cooked);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "ternary": {
      w.length(79);
      w.keys(Object.keys(v), KEYS182);
      encIrExpr(w, v.cond);
      encIrExpr(w, v.then);
      encIrExpr(w, v.else_);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "toBool": {
      w.length(80);
      w.keys(Object.keys(v), KEYS183);
      encIrExpr(w, v.operand);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "toString": {
      w.length(81);
      w.keys(Object.keys(v), KEYS184);
      encIrExpr(w, v.operand);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unary": {
      w.length(82);
      w.keys(Object.keys(v), KEYS185);
      w.str(v.op);
      encIrExpr(w, v.operand);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionDisc": {
      w.length(83);
      w.keys(Object.keys(v), KEYS186);
      w.str(v.unionId);
      w.str(v.field);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionEq": {
      w.length(84);
      w.keys(Object.keys(v), KEYS187);
      w.str(v.unionId);
      w.bool(v.negated);
      w.bool(v.sameValue);
      encIrExpr(w, v.left);
      encIrExpr(w, v.right);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionFuncEq": {
      w.length(85);
      w.keys(Object.keys(v), KEYS188);
      w.str(v.unionId);
      w.num(v.tag);
      encIrExpr(w, v.union);
      encIrExpr(w, v.func);
      w.bool(v.negated);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionIsTag": {
      w.length(86);
      w.keys(Object.keys(v), KEYS189);
      w.str(v.unionId);
      w.num(v.tag);
      w.bool(v.negated);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionKeyGet": {
      w.length(87);
      w.keys(Object.keys(v), KEYS190);
      w.str(v.unionId);
      encIrExpr(w, v.key);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionNarrow": {
      w.length(88);
      w.keys(Object.keys(v), KEYS191);
      w.str(v.unionId);
      w.num(v.tag);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionRetype": {
      w.length(89);
      w.keys(Object.keys(v), KEYS192);
      w.str(v.fromId);
      w.str(v.unionId);
      encT67(w, v.tags);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unionWrap": {
      w.length(90);
      w.keys(Object.keys(v), KEYS193);
      w.str(v.unionId);
      w.num(v.tag);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "unitLit": {
      w.length(91);
      w.keys(Object.keys(v), KEYS194);
      w.str(v.unit);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "upcast": {
      w.length(92);
      w.keys(Object.keys(v), KEYS195);
      encIrExpr(w, v.value);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "varRef": {
      w.length(93);
      w.keys(Object.keys(v), KEYS196);
      w.str(v.localId);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
    case "virtualCall": {
      w.length(94);
      w.keys(Object.keys(v), KEYS197);
      w.str(v.className);
      w.str(v.method);
      encT66(w, v.args);
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      if (v.targets === undefined) w.byte(0);
      else {
        w.byte(1);
        encT8(w, v.targets);
      }
      return;
    }
    case "yieldExpr": {
      w.length(95);
      w.keys(Object.keys(v), KEYS198);
      if (v.value === null) w.byte(0);
      else {
        w.byte(1);
        encIrExpr(w, v.value);
      }
      if (v.awaited === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.awaited);
      }
      if (v.delegated === undefined) w.byte(0);
      else {
        w.byte(1);
        w.bool(v.delegated);
      }
      if (v.captureCompletion === undefined) w.byte(0);
      else {
        w.byte(1);
        encT74(w, v.captureCompletion);
      }
      encIrType(w, v.type);
      encSrcLoc(w, v.loc);
      return;
    }
  }
  w.refuse("IrExpr kind " + String((v as { kind: unknown }).kind));
}
function decIrExpr(r: IrReader): IrExpr {
  switch (r.length()) {
    case 0: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "arrIntrinsic" }>["method"]>);
      const f1 = decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "arrIntrinsic" }> = { kind: "arrIntrinsic", method: f0, receiver: f1, args: f2, type: f3, loc: f4 };
      return o;
    }
    case 1: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "arrayGet" }> = { kind: "arrayGet", arr: f0, index: f1, type: f2, loc: f3 };
      return o;
    }
    case 2: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "arrayHas" }> = { kind: "arrayHas", arr: f0, index: f1, type: f2, loc: f3 };
      return o;
    }
    case 3: {
      const f0 = decT66(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<arrayLit>.spreads") === 0 ? undefined : decT67(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<arrayLit>.capacity") === 0 ? undefined : r.num();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "arrayLit" }> = { kind: "arrayLit", elems: f0, ...(f1 !== undefined ? { spreads: f1 } : {}), ...(f2 !== undefined ? { capacity: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 4: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "arrayNewLen" }> = { kind: "arrayNewLen", length: f0, type: f1, loc: f2 };
      return o;
    }
    case 5: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "arrayState" }> = { kind: "arrayState", arr: f0, index: f1, type: f2, loc: f3 };
      return o;
    }
    case 6: {
      const f0 = r.str();
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "assignExpr" }> = { kind: "assignExpr", localId: f0, value: f1, type: f2, loc: f3 };
      return o;
    }
    case 7: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<awaitExpr>.adopt") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "awaitExpr" }>["adopt"]>);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "awaitExpr" }> = { kind: "awaitExpr", value: f0, type: f1, ...(f2 !== undefined ? { adopt: f2 } : {}), loc: f3 };
      return o;
    }
    case 8: {
      const f0 = decIrExpr(r);
      const f1 = r.num();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "awaitUnionExpr" }> = { kind: "awaitUnionExpr", value: f0, promiseTag: f1, type: f2, loc: f3 };
      return o;
    }
    case 9: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "bin" }>["op"]>);
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "bin" }> = { kind: "bin", op: f0, left: f1, right: f2, type: f3, loc: f4 };
      return o;
    }
    case 10: {
      const f0 = r.bool();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "boolLit" }> = { kind: "boolLit", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 11: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "bytesIntrinsic" }>["method"]>);
      const f1 = decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const f5 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<bytesIntrinsic>.invalidNaN") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "bytesIntrinsic" }>["invalidNaN"]>);
      const o: Extract<IrExpr, { kind: "bytesIntrinsic" }> = { kind: "bytesIntrinsic", method: f0, receiver: f1, args: f2, type: f3, loc: f4, ...(f5 !== undefined ? { invalidNaN: f5 } : {}) };
      return o;
    }
    case 12: {
      const f0 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<bytesNew>.source") === 0 ? null : decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<bytesNew>.from") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "bytesNew" }>["from"]>);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "bytesNew" }> = { kind: "bytesNew", source: f0, ...(f1 !== undefined ? { from: f1 } : {}), type: f2, loc: f3 };
      return o;
    }
    case 13: {
      const f0 = r.str();
      const f1 = decT66(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "call" }> = { kind: "call", callee: f0, args: f1, type: f2, loc: f3 };
      return o;
    }
    case 14: {
      const f0 = decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<callValue>.receiver") === 0 ? undefined : decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "callValue" }> = { kind: "callValue", callee: f0, ...(f1 !== undefined ? { receiver: f1 } : {}), args: f2, type: f3, loc: f4 };
      return o;
    }
    case 15: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "caughtCheck" }> = { kind: "caughtCheck", value: f0, className: f1, type: f2, loc: f3 };
      return o;
    }
    case 16: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "caughtNarrow" }> = { kind: "caughtNarrow", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 17: {
      const f0 = decIrExpr(r);
      const f1 = (r.str() as NonNullable<Extract<IrExpr, { kind: "caughtTest" }>["test"]>);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<caughtTest>.className") === 0 ? undefined : r.str();
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<caughtTest>.negated") === 0 ? undefined : r.bool();
      const f4 = decIrType(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "caughtTest" }> = { kind: "caughtTest", value: f0, test: f1, ...(f2 !== undefined ? { className: f2 } : {}), ...(f3 !== undefined ? { negated: f3 } : {}), type: f4, loc: f5 };
      return o;
    }
    case 18: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "caughtToDyn" }> = { kind: "caughtToDyn", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 19: {
      const f0 = r.str();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "chainRecv" }> = { kind: "chainRecv", id: f0, type: f1, loc: f2 };
      return o;
    }
    case 20: {
      const f0 = r.str();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<classRef>.captures") === 0 ? undefined : decT8(r);
      const o: Extract<IrExpr, { kind: "classRef" }> = { kind: "classRef", className: f0, type: f1, loc: f2, ...(f3 !== undefined ? { captures: f3 } : {}) };
      return o;
    }
    case 21: {
      const f0 = r.str();
      const f1 = decT8(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<closure>.adapts") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "closure" }>["adapts"]>);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "closure" }> = { kind: "closure", fnName: f0, captures: f1, ...(f2 !== undefined ? { adapts: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 22: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "downcast" }> = { kind: "downcast", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 23: {
      const f0 = decT66(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynArrLit" }> = { kind: "dynArrLit", elems: f0, type: f1, loc: f2 };
      return o;
    }
    case 24: {
      const f0 = decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCall>.receiver") === 0 ? undefined : decIrExpr(r);
      const f2 = r.str();
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCall>.calleeNameValue") === 0 ? undefined : decIrExpr(r);
      const f4 = decT66(r);
      const f5 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCall>.spreads") === 0 ? undefined : decT68(r);
      const f6 = decIrType(r);
      const f7 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynCall" }> = { kind: "dynCall", callee: f0, ...(f1 !== undefined ? { receiver: f1 } : {}), calleeName: f2, ...(f3 !== undefined ? { calleeNameValue: f3 } : {}), args: f4, ...(f5 !== undefined ? { spreads: f5 } : {}), type: f6, loc: f7 };
      return o;
    }
    case 25: {
      const f0 = decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.preserveRefs") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynCheck" }>["preserveRefs"]>);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.adopt") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynCheck" }>["adopt"]>);
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.exact") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynCheck" }>["exact"]>);
      const f4 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.partialView") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynCheck" }>["partialView"]>);
      const f5 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.inferredSite") === 0 ? undefined : r.str();
      const f6 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.origin") === 0 ? undefined : r.num();
      const f7 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynCheck>.pathIndex") === 0 ? undefined : r.num();
      const f8 = decIrType(r);
      const f9 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynCheck" }> = { kind: "dynCheck", value: f0, ...(f1 !== undefined ? { preserveRefs: f1 } : {}), ...(f2 !== undefined ? { adopt: f2 } : {}), ...(f3 !== undefined ? { exact: f3 } : {}), ...(f4 !== undefined ? { partialView: f4 } : {}), ...(f5 !== undefined ? { inferredSite: f5 } : {}), ...(f6 !== undefined ? { origin: f6 } : {}), ...(f7 !== undefined ? { pathIndex: f7 } : {}), type: f8, loc: f9 };
      return o;
    }
    case 26: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynDestrCheck>.firstProp") === 0 ? undefined : r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynDestrCheck" }> = { kind: "dynDestrCheck", value: f0, spelling: f1, ...(f2 !== undefined ? { firstProp: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 27: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynFrom>.liveRef") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynFrom" }>["liveRef"]>);
      const f4 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynFrom>.fnName") === 0 ? undefined : r.str();
      const f5 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynFrom>.fnLength") === 0 ? undefined : r.num();
      const o: Extract<IrExpr, { kind: "dynFrom" }> = { kind: "dynFrom", value: f0, type: f1, loc: f2, ...(f3 !== undefined ? { liveRef: f3 } : {}), ...(f4 !== undefined ? { fnName: f4 } : {}), ...(f5 !== undefined ? { fnLength: f5 } : {}) };
      return o;
    }
    case 28: {
      const f0 = r.str();
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynHasKey>.negated") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynHasKey" }>["negated"]>);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynHasKey" }> = { kind: "dynHasKey", key: f0, ...(f1 !== undefined ? { negated: f1 } : {}), value: f2, type: f3, loc: f4 };
      return o;
    }
    case 29: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.str();
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynInvoke>.calleeNameValue") === 0 ? undefined : decIrExpr(r);
      const f4 = decT66(r);
      const f5 = decIrType(r);
      const f6 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynInvoke" }> = { kind: "dynInvoke", recv: f0, method: f1, calleeName: f2, ...(f3 !== undefined ? { calleeNameValue: f3 } : {}), args: f4, type: f5, loc: f6 };
      return o;
    }
    case 30: {
      const f0 = decIrExpr(r);
      const f1 = r.num();
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynIterN>.notIterableMessage") === 0 ? undefined : r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynIterN" }> = { kind: "dynIterN", value: f0, count: f1, ...(f2 !== undefined ? { notIterableMessage: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 31: {
      const f0 = decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynKeyGet>.optional") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynKeyGet" }>["optional"]>);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynKeyGet" }> = { kind: "dynKeyGet", key: f0, ...(f1 !== undefined ? { optional: f1 } : {}), value: f2, type: f3, loc: f4 };
      return o;
    }
    case 32: {
      const f0 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynObjLit>.fields") === 0 ? undefined : decT69(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynObjLit" }> = { kind: "dynObjLit", ...(f0 !== undefined ? { fields: f0 } : {}), type: f1, loc: f2 };
      return o;
    }
    case 33: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynScalarEq>.negated") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynScalarEq" }>["negated"]>);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynScalarEq" }> = { kind: "dynScalarEq", left: f0, right: f1, ...(f2 !== undefined ? { negated: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 34: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "dynTest" }>["test"]>);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynTest>.bytesElem") === 0 ? undefined : (r.str() as NonNullable<Extract<IrExpr, { kind: "dynTest" }>["bytesElem"]>);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<dynTest>.negated") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "dynTest" }>["negated"]>);
      const f3 = decIrExpr(r);
      const f4 = decIrType(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "dynTest" }> = { kind: "dynTest", test: f0, ...(f1 !== undefined ? { bytesElem: f1 } : {}), ...(f2 !== undefined ? { negated: f2 } : {}), value: f3, type: f4, loc: f5 };
      return o;
    }
    case 35: {
      const f0 = r.str();
      const f1 = decT66(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "ffiCall" }> = { kind: "ffiCall", import: f0, args: f1, type: f2, loc: f3 };
      return o;
    }
    case 36: {
      const f0 = r.str();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "fieldAbsent" }> = { kind: "fieldAbsent", unionId: f0, type: f1, loc: f2 };
      return o;
    }
    case 37: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "fieldGet" }> = { kind: "fieldGet", obj: f0, className: f1, field: f2, type: f3, loc: f4 };
      return o;
    }
    case 38: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "fieldIncDec" }>["op"]>);
      const f1 = r.bool();
      const f2 = decIrExpr(r);
      const f3 = r.str();
      const f4 = r.str();
      const f5 = r.bool();
      const f6 = decIrType(r);
      const f7 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "fieldIncDec" }> = { kind: "fieldIncDec", op: f0, prefix: f1, obj: f2, className: f3, field: f4, fieldDyn: f5, type: f6, loc: f7 };
      return o;
    }
    case 39: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "genResume" }>["mode"]>);
      const f1 = decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<genResume>.arg") === 0 ? null : decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "genResume" }> = { kind: "genResume", mode: f0, gen: f1, arg: f2, type: f3, loc: f4 };
      return o;
    }
    case 40: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "incDec" }>["op"]>);
      const f1 = r.bool();
      const f2 = r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "incDec" }> = { kind: "incDec", op: f0, prefix: f1, localId: f2, type: f3, loc: f4 };
      return o;
    }
    case 41: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "instanceOf" }> = { kind: "instanceOf", value: f0, className: f1, type: f2, loc: f3 };
      return o;
    }
    case 42: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "instanceOfValue" }> = { kind: "instanceOfValue", value: f0, classValue: f1, type: f2, loc: f3 };
      return o;
    }
    case 43: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "intrinsic" }>["name"]>);
      const f1 = decT66(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "intrinsic" }> = { kind: "intrinsic", name: f0, args: f1, type: f2, loc: f3 };
      return o;
    }
    case 44: {
      const f0 = decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<jsonStringify>.indent") === 0 ? undefined : r.str();
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<jsonStringify>.circular") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "jsonStringify" }>["circular"]>);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "jsonStringify" }> = { kind: "jsonStringify", value: f0, ...(f1 !== undefined ? { indent: f1 } : {}), ...(f2 !== undefined ? { circular: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 45: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "libCall" }>["fn"]>);
      const f1 = decT66(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const f4 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<libCall>.prototypeIdentityOnly") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "libCall" }>["prototypeIdentityOnly"]>);
      const f5 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<libCall>.realTimer") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "libCall" }>["realTimer"]>);
      const f6 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<libCall>.assertOptions") === 0 ? undefined : decT70(r);
      const f7 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<libCall>.bindsThis") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "libCall" }>["bindsThis"]>);
      const o: Extract<IrExpr, { kind: "libCall" }> = { kind: "libCall", fn: f0, args: f1, type: f2, loc: f3, ...(f4 !== undefined ? { prototypeIdentityOnly: f4 } : {}), ...(f5 !== undefined ? { realTimer: f5 } : {}), ...(f6 !== undefined ? { assertOptions: f6 } : {}), ...(f7 !== undefined ? { bindsThis: f7 } : {}) };
      return o;
    }
    case 46: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "logical" }>["op"]>);
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "logical" }> = { kind: "logical", op: f0, left: f1, right: f2, type: f3, loc: f4 };
      return o;
    }
    case 47: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "mapIntrinsic" }>["method"]>);
      const f1 = decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "mapIntrinsic" }> = { kind: "mapIntrinsic", method: f0, receiver: f1, args: f2, type: f3, loc: f4 };
      return o;
    }
    case 48: {
      const f0 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<mapNew>.seed") === 0 ? undefined : decT71(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "mapNew" }> = { kind: "mapNew", ...(f0 !== undefined ? { seed: f0 } : {}), type: f1, loc: f2 };
      return o;
    }
    case 49: {
      const f0 = r.str();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "moduleNsRef" }> = { kind: "moduleNsRef", moduleId: f0, type: f1, loc: f2 };
      return o;
    }
    case 50: {
      const f0 = r.str();
      const f1 = decT66(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "new" }> = { kind: "new", className: f0, args: f1, type: f2, loc: f3 };
      return o;
    }
    case 51: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "newPromise" }> = { kind: "newPromise", executor: f0, type: f1, loc: f2 };
      return o;
    }
    case 52: {
      const f0 = decIrExpr(r);
      const f1 = decT66(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "newValue" }> = { kind: "newValue", callee: f0, args: f1, type: f2, loc: f3 };
      return o;
    }
    case 53: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "nullish" }> = { kind: "nullish", left: f0, right: f1, type: f2, loc: f3 };
      return o;
    }
    case 54: {
      const f0 = r.num();
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<numLit>.spelling") === 0 ? undefined : r.str();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "numLit" }> = { kind: "numLit", value: f0, ...(f1 !== undefined ? { spelling: f1 } : {}), type: f2, loc: f3 };
      return o;
    }
    case 55: {
      const f0 = r.str();
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "optChain" }> = { kind: "optChain", id: f0, receiver: f1, body: f2, type: f3, loc: f4 };
      return o;
    }
    case 56: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<orDefault>.retag") === 0 ? undefined : r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "orDefault" }> = { kind: "orDefault", left: f0, right: f1, ...(f2 !== undefined ? { retag: f2 } : {}), type: f3, loc: f4 };
      return o;
    }
    case 57: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "promiseVoidWiden" }> = { kind: "promiseVoidWiden", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 58: {
      const f0 = decIrType(r);
      const f1 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "promiseWithResolvers" }> = { kind: "promiseWithResolvers", type: f0, loc: f1 };
      return o;
    }
    case 59: {
      const f0 = decIrExpr(r);
      const f1 = decT72(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordClone" }> = { kind: "recordClone", source: f0, overrides: f1, type: f2, loc: f3 };
      return o;
    }
    case 60: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordGet" }> = { kind: "recordGet", obj: f0, shapeId: f1, field: f2, type: f3, loc: f4 };
      return o;
    }
    case 61: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = r.str();
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordHas" }> = { kind: "recordHas", obj: f0, shapeId: f1, field: f2, type: f3, loc: f4 };
      return o;
    }
    case 62: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrExpr(r);
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<recordKeyGet>.overflowOnly") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "recordKeyGet" }>["overflowOnly"]>);
      const f4 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<recordKeyGet>.missNaN") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "recordKeyGet" }>["missNaN"]>);
      const f5 = decIrType(r);
      const f6 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordKeyGet" }> = { kind: "recordKeyGet", obj: f0, shapeId: f1, key: f2, ...(f3 !== undefined ? { overflowOnly: f3 } : {}), ...(f4 !== undefined ? { missNaN: f4 } : {}), type: f5, loc: f6 };
      return o;
    }
    case 63: {
      const f0 = decT73(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<recordLit>.nullProto") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "recordLit" }>["nullProto"]>);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordLit" }> = { kind: "recordLit", fields: f0, ...(f1 !== undefined ? { nullProto: f1 } : {}), type: f2, loc: f3 };
      return o;
    }
    case 64: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordNullProto" }> = { kind: "recordNullProto", obj: f0, shapeId: f1, type: f2, loc: f3 };
      return o;
    }
    case 65: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordOvfHas" }> = { kind: "recordOvfHas", obj: f0, shapeId: f1, key: f2, type: f3, loc: f4 };
      return o;
    }
    case 66: {
      const f0 = decIrExpr(r);
      const f1 = r.str();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "recordOvfKeys" }> = { kind: "recordOvfKeys", obj: f0, shapeId: f1, type: f2, loc: f3 };
      return o;
    }
    case 67: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "regexIntrinsic" }>["method"]>);
      const f1 = decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "regexIntrinsic" }> = { kind: "regexIntrinsic", method: f0, receiver: f1, args: f2, type: f3, loc: f4 };
      return o;
    }
    case 68: {
      const f0 = r.str();
      const f1 = r.str();
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "regexLit" }> = { kind: "regexLit", pattern: f0, flags: f1, type: f2, loc: f3 };
      return o;
    }
    case 69: {
      const f0 = decIrType(r);
      const f1 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "selfRef" }> = { kind: "selfRef", type: f0, loc: f1 };
      return o;
    }
    case 70: {
      const f0 = decT20(r);
      const f1 = decIrExpr(r);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<seqExpr>.generatorDelegate") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "seqExpr" }>["generatorDelegate"]>);
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<seqExpr>.diverges") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "seqExpr" }>["diverges"]>);
      const f4 = decIrType(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "seqExpr" }> = { kind: "seqExpr", stmts: f0, result: f1, ...(f2 !== undefined ? { generatorDelegate: f2 } : {}), ...(f3 !== undefined ? { diverges: f3 } : {}), type: f4, loc: f5 };
      return o;
    }
    case 71: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "setIntrinsic" }>["method"]>);
      const f1 = decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "setIntrinsic" }> = { kind: "setIntrinsic", method: f0, receiver: f1, args: f2, type: f3, loc: f4 };
      return o;
    }
    case 72: {
      const f0 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<setNew>.seed") === 0 ? undefined : decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "setNew" }> = { kind: "setNew", ...(f0 !== undefined ? { seed: f0 } : {}), type: f1, loc: f2 };
      return o;
    }
    case 73: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "strCmp" }>["op"]>);
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "strCmp" }> = { kind: "strCmp", op: f0, left: f1, right: f2, type: f3, loc: f4 };
      return o;
    }
    case 74: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "strConcat" }> = { kind: "strConcat", left: f0, right: f1, type: f2, loc: f3 };
      return o;
    }
    case 75: {
      const f0 = r.bool();
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "strEq" }> = { kind: "strEq", negated: f0, left: f1, right: f2, type: f3, loc: f4 };
      return o;
    }
    case 76: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "strIntrinsic" }>["method"]>);
      const f1 = decIrExpr(r);
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "strIntrinsic" }> = { kind: "strIntrinsic", method: f0, receiver: f1, args: f2, type: f3, loc: f4 };
      return o;
    }
    case 77: {
      const f0 = r.str();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "strLit" }> = { kind: "strLit", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 78: {
      const f0 = r.str();
      const f1 = decT8(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "templateStrings" }> = { kind: "templateStrings", key: f0, cooked: f1, type: f2, loc: f3 };
      return o;
    }
    case 79: {
      const f0 = decIrExpr(r);
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "ternary" }> = { kind: "ternary", cond: f0, then: f1, else_: f2, type: f3, loc: f4 };
      return o;
    }
    case 80: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "toBool" }> = { kind: "toBool", operand: f0, type: f1, loc: f2 };
      return o;
    }
    case 81: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "toString" }> = { kind: "toString", operand: f0, type: f1, loc: f2 };
      return o;
    }
    case 82: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "unary" }>["op"]>);
      const f1 = decIrExpr(r);
      const f2 = decIrType(r);
      const f3 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unary" }> = { kind: "unary", op: f0, operand: f1, type: f2, loc: f3 };
      return o;
    }
    case 83: {
      const f0 = r.str();
      const f1 = r.str();
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionDisc" }> = { kind: "unionDisc", unionId: f0, field: f1, value: f2, type: f3, loc: f4 };
      return o;
    }
    case 84: {
      const f0 = r.str();
      const f1 = r.bool();
      const f2 = r.bool();
      const f3 = decIrExpr(r);
      const f4 = decIrExpr(r);
      const f5 = decIrType(r);
      const f6 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionEq" }> = { kind: "unionEq", unionId: f0, negated: f1, sameValue: f2, left: f3, right: f4, type: f5, loc: f6 };
      return o;
    }
    case 85: {
      const f0 = r.str();
      const f1 = r.num();
      const f2 = decIrExpr(r);
      const f3 = decIrExpr(r);
      const f4 = r.bool();
      const f5 = decIrType(r);
      const f6 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionFuncEq" }> = { kind: "unionFuncEq", unionId: f0, tag: f1, union: f2, func: f3, negated: f4, type: f5, loc: f6 };
      return o;
    }
    case 86: {
      const f0 = r.str();
      const f1 = r.num();
      const f2 = r.bool();
      const f3 = decIrExpr(r);
      const f4 = decIrType(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionIsTag" }> = { kind: "unionIsTag", unionId: f0, tag: f1, negated: f2, value: f3, type: f4, loc: f5 };
      return o;
    }
    case 87: {
      const f0 = r.str();
      const f1 = decIrExpr(r);
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionKeyGet" }> = { kind: "unionKeyGet", unionId: f0, key: f1, value: f2, type: f3, loc: f4 };
      return o;
    }
    case 88: {
      const f0 = r.str();
      const f1 = r.num();
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionNarrow" }> = { kind: "unionNarrow", unionId: f0, tag: f1, value: f2, type: f3, loc: f4 };
      return o;
    }
    case 89: {
      const f0 = r.str();
      const f1 = r.str();
      const f2 = decT67(r);
      const f3 = decIrExpr(r);
      const f4 = decIrType(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionRetype" }> = { kind: "unionRetype", fromId: f0, unionId: f1, tags: f2, value: f3, type: f4, loc: f5 };
      return o;
    }
    case 90: {
      const f0 = r.str();
      const f1 = r.num();
      const f2 = decIrExpr(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unionWrap" }> = { kind: "unionWrap", unionId: f0, tag: f1, value: f2, type: f3, loc: f4 };
      return o;
    }
    case 91: {
      const f0 = (r.str() as NonNullable<Extract<IrExpr, { kind: "unitLit" }>["unit"]>);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "unitLit" }> = { kind: "unitLit", unit: f0, type: f1, loc: f2 };
      return o;
    }
    case 92: {
      const f0 = decIrExpr(r);
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "upcast" }> = { kind: "upcast", value: f0, type: f1, loc: f2 };
      return o;
    }
    case 93: {
      const f0 = r.str();
      const f1 = decIrType(r);
      const f2 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "varRef" }> = { kind: "varRef", localId: f0, type: f1, loc: f2 };
      return o;
    }
    case 94: {
      const f0 = r.str();
      const f1 = r.str();
      const f2 = decT66(r);
      const f3 = decIrType(r);
      const f4 = decSrcLoc(r);
      const f5 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<virtualCall>.targets") === 0 ? undefined : decT8(r);
      const o: Extract<IrExpr, { kind: "virtualCall" }> = { kind: "virtualCall", className: f0, method: f1, args: f2, type: f3, loc: f4, ...(f5 !== undefined ? { targets: f5 } : {}) };
      return o;
    }
    case 95: {
      const f0 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<yieldExpr>.value") === 0 ? null : decIrExpr(r);
      const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<yieldExpr>.awaited") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "yieldExpr" }>["awaited"]>);
      const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<yieldExpr>.delegated") === 0 ? undefined : (r.bool() as NonNullable<Extract<IrExpr, { kind: "yieldExpr" }>["delegated"]>);
      const f3 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<yieldExpr>.captureCompletion") === 0 ? undefined : decT74(r);
      const f4 = decIrType(r);
      const f5 = decSrcLoc(r);
      const o: Extract<IrExpr, { kind: "yieldExpr" }> = { kind: "yieldExpr", value: f0, ...(f1 !== undefined ? { awaited: f1 } : {}), ...(f2 !== undefined ? { delegated: f2 } : {}), ...(f3 !== undefined ? { captureCompletion: f3 } : {}), type: f4, loc: f5 };
      return o;
    }
  }
  throw new Error("IR codec: invalid IrExpr kind");
}

function encT56(w: IrWriter, v: NonNullable<Extract<IrStmt, { kind: "switch" }>["cases"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT75(w, item);
  }
}
function decT56(r: IrReader): NonNullable<Extract<IrStmt, { kind: "switch" }>["cases"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrStmt, { kind: "switch" }>["cases"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT75(r));
  return out;
}

function encT57(w: IrWriter, v: NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>): void {
  if (typeof v === "object" && "globalId" in v) {
    w.length(0);
    encT76(w, v as Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { globalId: unknown }>);
    return;
  }
  if (typeof v === "object" && "wellKnown" in v) {
    w.length(1);
    encT77(w, v as Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { wellKnown: unknown }>);
    return;
  }
  throw new Error("IR codec: no arm of T57 matches");
}
function decT57(r: IrReader): NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]> {
  switch (r.length()) {
    case 0:
      return decT76(r) as NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>;
    case 1:
      return decT77(r) as NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>;
  }
  throw new Error("IR codec: invalid T57 arm");
}

function encT58(w: IrWriter, v: NonNullable<NonNullable<IrClassDef["fields"]>[number]>): void {
  w.keys(Object.keys(v), KEYS199);
  w.str(v.name);
  encIrType(w, v.type);
}
function decT58(r: IrReader): NonNullable<NonNullable<IrClassDef["fields"]>[number]> {
  const f0 = r.str();
  const f1 = decIrType(r);
  const o: NonNullable<NonNullable<IrClassDef["fields"]>[number]> = { name: f0, type: f1 };
  return o;
}

function encT59(w: IrWriter, v: NonNullable<NonNullable<IrRecordShape["fields"]>[number]>): void {
  w.keys(Object.keys(v), KEYS200);
  w.str(v.name);
  encIrType(w, v.type);
}
function decT59(r: IrReader): NonNullable<NonNullable<IrRecordShape["fields"]>[number]> {
  const f0 = r.str();
  const f1 = decIrType(r);
  const o: NonNullable<NonNullable<IrRecordShape["fields"]>[number]> = { name: f0, type: f1 };
  return o;
}

function encT60(w: IrWriter, v: NonNullable<IrUnionDiscriminant["cases"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT78(w, item);
  }
}
function decT60(r: IrReader): NonNullable<IrUnionDiscriminant["cases"]> {
  const length = r.length();
  const out: NonNullable<IrUnionDiscriminant["cases"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT78(r));
  return out;
}

function encT61(w: IrWriter, v: NonNullable<NonNullable<IrNodeIslandModules["files"]>[number]>): void {
  w.keys(Object.keys(v), KEYS201);
  w.str(v.path);
  w.num(v.size);
  w.str(v.sha256);
  if (v.placeholder === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.placeholder);
  }
}
function decT61(r: IrReader): NonNullable<NonNullable<IrNodeIslandModules["files"]>[number]> {
  const f0 = r.str();
  const f1 = r.num();
  const f2 = r.str();
  const f3 = r.tag(2, "IrModule.nodeIsland.modules.files[].placeholder") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<NonNullable<IrNodeIslandModules["files"]>[number]>["placeholder"]>);
  const o: NonNullable<NonNullable<IrNodeIslandModules["files"]>[number]> = { path: f0, size: f1, sha256: f2, ...(f3 !== undefined ? { placeholder: f3 } : {}) };
  return o;
}

function encT62(w: IrWriter, v: NonNullable<NonNullable<IrNodeIslandModules["links"]>[number]>): void {
  w.keys(Object.keys(v), KEYS202);
  w.str(v.path);
  w.str(v.target);
}
function decT62(r: IrReader): NonNullable<NonNullable<IrNodeIslandModules["links"]>[number]> {
  const f0 = r.str();
  const f1 = r.str();
  const o: NonNullable<NonNullable<IrNodeIslandModules["links"]>[number]> = { path: f0, target: f1 };
  return o;
}

function encIrFfiParam(w: IrWriter, v: IrFfiParam): void {
  if (typeof v === "string") {
    w.length(0);
    w.str(v);
    return;
  }
  if (typeof v === "object" && "context" in v) {
    w.length(1);
    encIrFfiContextParam(w, v as Extract<IrFfiParam, { context: unknown }>);
    return;
  }
  if (typeof v === "object" && "callback" in v && "id" in (v as { callback: object }).callback) {
    w.length(2);
    encIrFfiCallbackParam(w, v as Extract<IrFfiParam, { callback: { id: unknown } }>);
    return;
  }
  if (typeof v === "object" && "callback" in v && "release" in (v as { callback: object }).callback) {
    w.length(3);
    encIrFfiReleaseParam(w, v as Extract<IrFfiParam, { callback: { release: unknown } }>);
    return;
  }
  throw new Error("IR codec: no arm of IrFfiParam matches");
}
function decIrFfiParam(r: IrReader): IrFfiParam {
  switch (r.length()) {
    case 0:
      return r.str() as IrFfiParam;
    case 1:
      return decIrFfiContextParam(r) as IrFfiParam;
    case 2:
      return decIrFfiCallbackParam(r) as IrFfiParam;
    case 3:
      return decIrFfiReleaseParam(r) as IrFfiParam;
  }
  throw new Error("IR codec: invalid IrFfiParam arm");
}

function encT64(w: IrWriter, v: NonNullable<IrLibCallback["params"]>): void {
  w.length(v.length);
  for (const item of v) {
    w.str(item);
  }
}
function decT64(r: IrReader): NonNullable<IrLibCallback["params"]> {
  const length = r.length();
  const out: NonNullable<IrLibCallback["params"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push((r.str() as NonNullable<NonNullable<IrLibCallback["params"]>[number]>));
  return out;
}

function encT65(w: IrWriter, v: NonNullable<IrLibExport["params"]>): void {
  w.length(v.length);
  for (const item of v) {
    w.str(item);
  }
}
function decT65(r: IrReader): NonNullable<IrLibExport["params"]> {
  const length = r.length();
  const out: NonNullable<IrLibExport["params"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push((r.str() as NonNullable<NonNullable<IrLibExport["params"]>[number]>));
  return out;
}

function encT66(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "arrIntrinsic" }>["args"]>): void {
  w.length(v.length);
  for (const item of v) {
    encIrExpr(w, item);
  }
}
function decT66(r: IrReader): NonNullable<Extract<IrExpr, { kind: "arrIntrinsic" }>["args"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "arrIntrinsic" }>["args"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decIrExpr(r));
  return out;
}

function encT67(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "arrayLit" }>["spreads"]>): void {
  w.length(v.length);
  for (const item of v) {
    w.num(item);
  }
}
function decT67(r: IrReader): NonNullable<Extract<IrExpr, { kind: "arrayLit" }>["spreads"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "arrayLit" }>["spreads"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(r.num());
  return out;
}

function encT68(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "dynCall" }>["spreads"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT82(w, item);
  }
}
function decT68(r: IrReader): NonNullable<Extract<IrExpr, { kind: "dynCall" }>["spreads"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "dynCall" }>["spreads"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT82(r));
  return out;
}

function encT69(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "dynObjLit" }>["fields"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT83(w, item);
  }
}
function decT69(r: IrReader): NonNullable<Extract<IrExpr, { kind: "dynObjLit" }>["fields"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "dynObjLit" }>["fields"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT83(r));
  return out;
}

function encT70(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "libCall" }>["assertOptions"]>): void {
  w.keys(Object.keys(v), KEYS203);
  if (v.diff === undefined) w.byte(0);
  else {
    w.byte(1);
    w.str(v.diff);
  }
  if (v.skipPrototype === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.skipPrototype);
  }
}
function decT70(r: IrReader): NonNullable<Extract<IrExpr, { kind: "libCall" }>["assertOptions"]> {
  const f0 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<libCall>.assertOptions.diff") === 0 ? undefined : (r.str() as NonNullable<NonNullable<Extract<IrExpr, { kind: "libCall" }>["assertOptions"]>["diff"]>);
  const f1 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<libCall>.assertOptions.skipPrototype") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<Extract<IrExpr, { kind: "libCall" }>["assertOptions"]>["skipPrototype"]>);
  const o: NonNullable<Extract<IrExpr, { kind: "libCall" }>["assertOptions"]> = { ...(f0 !== undefined ? { diff: f0 } : {}), ...(f1 !== undefined ? { skipPrototype: f1 } : {}) };
  return o;
}

function encT71(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "mapNew" }>["seed"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT84(w, item);
  }
}
function decT71(r: IrReader): NonNullable<Extract<IrExpr, { kind: "mapNew" }>["seed"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "mapNew" }>["seed"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT84(r));
  return out;
}

function encT72(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "recordClone" }>["overrides"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT85(w, item);
  }
}
function decT72(r: IrReader): NonNullable<Extract<IrExpr, { kind: "recordClone" }>["overrides"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "recordClone" }>["overrides"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT85(r));
  return out;
}

function encT73(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT86(w, item);
  }
}
function decT73(r: IrReader): NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]> {
  const length = r.length();
  const out: NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT86(r));
  return out;
}

function encT74(w: IrWriter, v: NonNullable<Extract<IrExpr, { kind: "yieldExpr" }>["captureCompletion"]>): void {
  w.keys(Object.keys(v), KEYS204);
  encIrType(w, v.returnType);
}
function decT74(r: IrReader): NonNullable<Extract<IrExpr, { kind: "yieldExpr" }>["captureCompletion"]> {
  const f0 = decIrType(r);
  const o: NonNullable<Extract<IrExpr, { kind: "yieldExpr" }>["captureCompletion"]> = { returnType: f0 };
  return o;
}

function encT75(w: IrWriter, v: NonNullable<NonNullable<Extract<IrStmt, { kind: "switch" }>["cases"]>[number]>): void {
  w.keys(Object.keys(v), KEYS205);
  if (v.test === null) w.byte(0);
  else {
    w.byte(1);
    encIrExpr(w, v.test);
  }
  encT20(w, v.body);
}
function decT75(r: IrReader): NonNullable<NonNullable<Extract<IrStmt, { kind: "switch" }>["cases"]>[number]> {
  const f0 = r.tag(2, "IrFunction.body[]<switch>.cases[].test") === 0 ? null : decIrExpr(r);
  const f1 = decT20(r);
  const o: NonNullable<NonNullable<Extract<IrStmt, { kind: "switch" }>["cases"]>[number]> = { test: f0, body: f1 };
  return o;
}

function encT76(w: IrWriter, v: Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { globalId: unknown }>): void {
  w.keys(Object.keys(v), KEYS206);
  w.str(v.field);
  w.str(v.globalId);
}
function decT76(r: IrReader): Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { globalId: unknown }> {
  const f0 = r.str();
  const f1 = r.str();
  const o: Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { globalId: unknown }> = { field: f0, globalId: f1 };
  return o;
}

function encT77(w: IrWriter, v: Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { wellKnown: unknown }>): void {
  w.keys(Object.keys(v), KEYS207);
  w.str(v.field);
  w.str(v.wellKnown);
}
function decT77(r: IrReader): Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { wellKnown: unknown }> {
  const f0 = r.str();
  const f1 = r.str();
  const o: Extract<NonNullable<NonNullable<IrClassDef["symbolFields"]>[number]>, { wellKnown: unknown }> = { field: f0, wellKnown: f1 };
  return o;
}

function encT78(w: IrWriter, v: NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>): void {
  w.keys(Object.keys(v), KEYS208);
  w.num(v.tag);
  encT87(w, v.values);
}
function decT78(r: IrReader): NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]> {
  const f0 = r.num();
  const f1 = decT87(r);
  const o: NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]> = { tag: f0, values: f1 };
  return o;
}

function encIrFfiContextParam(w: IrWriter, v: IrFfiContextParam): void {
  w.keys(Object.keys(v), KEYS209);
  w.str(v.context);
}
function decIrFfiContextParam(r: IrReader): IrFfiContextParam {
  const f0 = r.str();
  const o: IrFfiContextParam = { context: f0 };
  return o;
}

function encIrFfiCallbackParam(w: IrWriter, v: IrFfiCallbackParam): void {
  w.keys(Object.keys(v), KEYS210);
  encT88(w, v.callback);
}
function decIrFfiCallbackParam(r: IrReader): IrFfiCallbackParam {
  const f0 = decT88(r);
  const o: IrFfiCallbackParam = { callback: f0 };
  return o;
}

function encIrFfiReleaseParam(w: IrWriter, v: IrFfiReleaseParam): void {
  w.keys(Object.keys(v), KEYS211);
  encT89(w, v.callback);
}
function decIrFfiReleaseParam(r: IrReader): IrFfiReleaseParam {
  const f0 = decT89(r);
  const o: IrFfiReleaseParam = { callback: f0 };
  return o;
}

function encT82(w: IrWriter, v: NonNullable<NonNullable<Extract<IrExpr, { kind: "dynCall" }>["spreads"]>[number]>): void {
  w.keys(Object.keys(v), KEYS212);
  w.num(v.arg);
  w.str(v.what);
}
function decT82(r: IrReader): NonNullable<NonNullable<Extract<IrExpr, { kind: "dynCall" }>["spreads"]>[number]> {
  const f0 = r.num();
  const f1 = r.str();
  const o: NonNullable<NonNullable<Extract<IrExpr, { kind: "dynCall" }>["spreads"]>[number]> = { arg: f0, what: f1 };
  return o;
}

function encT83(w: IrWriter, v: NonNullable<NonNullable<Extract<IrExpr, { kind: "dynObjLit" }>["fields"]>[number]>): void {
  w.keys(Object.keys(v), KEYS213);
  encIrExpr(w, v.key);
  encIrExpr(w, v.value);
}
function decT83(r: IrReader): NonNullable<NonNullable<Extract<IrExpr, { kind: "dynObjLit" }>["fields"]>[number]> {
  const f0 = decIrExpr(r);
  const f1 = decIrExpr(r);
  const o: NonNullable<NonNullable<Extract<IrExpr, { kind: "dynObjLit" }>["fields"]>[number]> = { key: f0, value: f1 };
  return o;
}

function encT84(w: IrWriter, v: NonNullable<NonNullable<Extract<IrExpr, { kind: "mapNew" }>["seed"]>[number]>): void {
  w.keys(Object.keys(v), KEYS214);
  encIrExpr(w, v.key);
  encIrExpr(w, v.value);
}
function decT84(r: IrReader): NonNullable<NonNullable<Extract<IrExpr, { kind: "mapNew" }>["seed"]>[number]> {
  const f0 = decIrExpr(r);
  const f1 = decIrExpr(r);
  const o: NonNullable<NonNullable<Extract<IrExpr, { kind: "mapNew" }>["seed"]>[number]> = { key: f0, value: f1 };
  return o;
}

function encT85(w: IrWriter, v: NonNullable<NonNullable<Extract<IrExpr, { kind: "recordClone" }>["overrides"]>[number]>): void {
  w.keys(Object.keys(v), KEYS215);
  w.str(v.name);
  encIrExpr(w, v.value);
}
function decT85(r: IrReader): NonNullable<NonNullable<Extract<IrExpr, { kind: "recordClone" }>["overrides"]>[number]> {
  const f0 = r.str();
  const f1 = decIrExpr(r);
  const o: NonNullable<NonNullable<Extract<IrExpr, { kind: "recordClone" }>["overrides"]>[number]> = { name: f0, value: f1 };
  return o;
}

function encT86(w: IrWriter, v: NonNullable<NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]>[number]>): void {
  w.keys(Object.keys(v), KEYS216);
  w.str(v.name);
  encIrExpr(w, v.value);
  if (v.overflow === undefined) w.byte(0);
  else {
    w.byte(1);
    w.bool(v.overflow);
  }
}
function decT86(r: IrReader): NonNullable<NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]>[number]> {
  const f0 = r.str();
  const f1 = decIrExpr(r);
  const f2 = r.tag(2, "IrFunction.body[]<arrayDelete>.arr<recordLit>.fields[].overflow") === 0 ? undefined : (r.bool() as NonNullable<NonNullable<NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]>[number]>["overflow"]>);
  const o: NonNullable<NonNullable<Extract<IrExpr, { kind: "recordLit" }>["fields"]>[number]> = { name: f0, value: f1, ...(f2 !== undefined ? { overflow: f2 } : {}) };
  return o;
}

function encT87(w: IrWriter, v: NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT90(w, item);
  }
}
function decT87(r: IrReader): NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]> {
  const length = r.length();
  const out: NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT90(r));
  return out;
}

function encT88(w: IrWriter, v: NonNullable<IrFfiCallbackParam["callback"]>): void {
  w.keys(Object.keys(v), KEYS217);
  w.str(v.id);
  encT91(w, v.params);
  w.str(v.returns);
  w.str(v.lifetime);
  w.str(v.invoke);
}
function decT88(r: IrReader): NonNullable<IrFfiCallbackParam["callback"]> {
  const f0 = r.str();
  const f1 = decT91(r);
  const f2 = (r.str() as NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["returns"]>);
  const f3 = (r.str() as NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["lifetime"]>);
  const f4 = (r.str() as NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["invoke"]>);
  const o: NonNullable<IrFfiCallbackParam["callback"]> = { id: f0, params: f1, returns: f2, lifetime: f3, invoke: f4 };
  return o;
}

function encT89(w: IrWriter, v: NonNullable<IrFfiReleaseParam["callback"]>): void {
  w.keys(Object.keys(v), KEYS218);
  w.str(v.release);
  encT91(w, v.params);
  w.str(v.returns);
}
function decT89(r: IrReader): NonNullable<IrFfiReleaseParam["callback"]> {
  const f0 = r.str();
  const f1 = decT91(r);
  const f2 = (r.str() as NonNullable<NonNullable<IrFfiReleaseParam["callback"]>["returns"]>);
  const o: NonNullable<IrFfiReleaseParam["callback"]> = { release: f0, params: f1, returns: f2 };
  return o;
}

function encT90(w: IrWriter, v: NonNullable<NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>[number]>): void {
  if (typeof v === "string") {
    w.length(0);
    w.str(v);
    return;
  }
  if (typeof v === "number") {
    w.length(1);
    w.num(v);
    return;
  }
  if (typeof v === "boolean") {
    w.length(2);
    w.bool(v);
    return;
  }
  throw new Error("IR codec: no arm of T90 matches");
}
function decT90(r: IrReader): NonNullable<NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>[number]> {
  switch (r.length()) {
    case 0:
      return r.str() as NonNullable<NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>[number]>;
    case 1:
      return r.num() as NonNullable<NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>[number]>;
    case 2:
      return r.bool() as NonNullable<NonNullable<NonNullable<NonNullable<IrUnionDiscriminant["cases"]>[number]>["values"]>[number]>;
  }
  throw new Error("IR codec: invalid T90 arm");
}

function encT91(w: IrWriter, v: NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>): void {
  w.length(v.length);
  for (const item of v) {
    encT92(w, item);
  }
}
function decT91(r: IrReader): NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]> {
  const length = r.length();
  const out: NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>[number][] = [];
  for (let i = 0; i < length; i++) out.push(decT92(r));
  return out;
}

function encT92(w: IrWriter, v: NonNullable<NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>[number]>): void {
  if (typeof v === "string") {
    w.length(0);
    w.str(v);
    return;
  }
  if (true) {
    w.length(1);
    encIrFfiContextParam(w, v as Exclude<NonNullable<NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>[number]>, string | number | boolean | readonly unknown[]>);
    return;
  }
  throw new Error("IR codec: no arm of T92 matches");
}
function decT92(r: IrReader): NonNullable<NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>[number]> {
  switch (r.length()) {
    case 0:
      return r.str() as NonNullable<NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>[number]>;
    case 1:
      return decIrFfiContextParam(r) as NonNullable<NonNullable<NonNullable<IrFfiCallbackParam["callback"]>["params"]>[number]>;
  }
  throw new Error("IR codec: invalid T92 arm");
}
