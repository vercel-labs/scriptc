/* IR validation — runs on every compile as the backstop for frontend bugs.
 * A violation is an internal compiler error (the frontend should never
 * produce invalid IR), but it still carries the user's source location:
 * an ICE that points at source is a gift to whoever debugs it.
 */
import { validByteNumberToken } from "./byte-numbers.js";
import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrGlobal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "./ir.js";
import {
  arrayOf,
  BYTES_ELEMENT_NAME,
  BOOL,
  BYTES_U8,
  bytesOf,
  canAdaptDynFuncTo,
  canDynCheckTo,
  canConvertToDyn,
  canExitIslandToType,
  canMarshalIntoIsland,
  canMarshalTypedFuncIntoIsland,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  ffiClassType,
  ffiSourceParamTypes,
  islandPromisePayloadTag,
  isDynTypedRefType,
  isFfiCallbackParam,
  isFfiContextParam,
  isFfiReleaseParam,
  isJsonSafeType,
  isJsonStringifySafeType,
  isRefCounted,
  isSupportedArrayElem,
  isSupportedIndexValue,
  isSupportedMapKey,
  isSupportedMapValue,
  isSupportedSetElem,
  isUnitType,
  jsOpResultKind,
  JSVAL,
  REF_TRUTHY_KINDS,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
  shapeHasAccessorSlots,
  STRING,
  typeEquals,
  typeKey,
  unionContainerArmsOk,
  VOID,
} from "./ir.js";
import { DYN_CLASS_PROPERTIES } from "./ir.js";
import { unionWideningTags } from "./analysis.js";
import { alwaysReturns } from "./control-flow.js";
import { LIB_FN_SIGS } from "./builtin-signatures.js";
import { REGEX_INTRINSIC_SIGS, STR_INTRINSIC_SIGS } from "./intrinsic-signatures.js";

/** True for an object type naming a runtime-provided error class. */
function isBuiltinErrorObject(t: IrType): boolean {
  return t.kind === "object" && RUNTIME_ERROR_CLASSES.has(t.className);
}

export interface IrValidationError {
  message: string;
  loc: SrcLoc;
}

/** The type a CALL SITE (or function value) receives from a module
 * function: an async body's returnType is the promise's INNER type, so
 * calls and closures over it see Promise<T>; a generator body's is the
 * TReturn channel, so call sites see the generator type. The one place
 * the body/call-site split is spelled out in the validator. */
function callSiteReturnType(fn: IrFunction): IrType {
  if (fn.async && fn.generator !== undefined) {
    return {
      kind: "generator",
      async: true,
      yieldT: fn.generator.yieldT,
      retT: fn.returnType,
      nextT: fn.generator.nextT,
    };
  }
  if (fn.async) return { kind: "promise", inner: fn.returnType };
  if (fn.generator !== undefined) {
    return {
      kind: "generator",
      yieldT: fn.generator.yieldT,
      retT: fn.returnType,
      nextT: fn.generator.nextT,
    };
  }
  return fn.returnType;
}

interface VirtualCallInfo {
  declared: boolean;
  hasOverride: boolean;
  implementation: IrFunction | undefined;
}

interface RecordValidation {
  fields: Map<string, IrType>;
  initializationFields: Map<string, IrType>;
  hasAccessorSlots: boolean;
}

interface ClassValidation {
  fields: Map<string, Map<string, IrType>>;
  hierarchy: Set<string>;
  implementations: Map<string, IrClassDef[]>;
  virtualCalls: Map<string, Map<string, VirtualCallInfo>>;
}

export function validateModule(mod: IrModule): IrValidationError[] {
  const errors: IrValidationError[] = [];
  const functionsByName = new Map<string, IrFunction>();
  for (const fn of mod.functions) {
    if (functionsByName.has(fn.name)) {
      errors.push({ message: `duplicate function "${fn.name}"`, loc: fn.loc });
    }
    functionsByName.set(fn.name, fn);
  }
  const ffiByName = new Map<string, NonNullable<IrModule["ffiImports"]>[number]>();
  const ffiSymbols = new Set<string>();
  const moduleLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  if (mod.workers !== undefined && typeof mod.workers !== "boolean")
    errors.push({ message: "worker execution mode must be a boolean", loc: moduleLoc });
  if (mod.workers && (mod.lib !== undefined || mod.embedded !== undefined))
    errors.push({
      message: "worker execution requires a native static executable",
      loc: moduleLoc,
    });
  for (const entry of mod.ffiImports ?? []) {
    if (
      mod.workers &&
      entry.params.some(
        (parameter) => isFfiCallbackParam(parameter) && parameter.callback.invoke === "foreign",
      )
    )
      errors.push({
        message: "worker execution cannot install foreign-thread callbacks",
        loc: moduleLoc,
      });
    if (ffiByName.has(entry.name)) {
      errors.push({ message: `duplicate FFI binding "${entry.name}"`, loc: moduleLoc });
    }
    if (ffiSymbols.has(entry.symbol)) {
      errors.push({ message: `duplicate FFI symbol "${entry.symbol}"`, loc: moduleLoc });
    }
    ffiByName.set(entry.name, entry);
    ffiSymbols.add(entry.symbol);
  }
  const retainedFfiCallbacks = new Map<
    string,
    Extract<
      NonNullable<IrModule["ffiImports"]>[number]["params"][number],
      { callback: { id: string } }
    >["callback"]
  >();
  for (const entry of mod.ffiImports ?? []) {
    if (entry.callbackOperation !== undefined) {
      const fail = (detail: string): void => {
        errors.push({
          message: `FFI callback operation "${entry.name}" ${detail}`,
          loc: moduleLoc,
        });
      };
      if (!entry.library || entry.library.includes("\0")) fail("requires a library name");
      if (entry.callbackOperation === "register") {
        const param = entry.params[0];
        if (
          entry.params.length !== 1 ||
          !param ||
          !isFfiCallbackParam(param) ||
          param.callback.id !== "callback" ||
          param.callback.lifetime !== "retained" ||
          param.callback.invoke !== "script-thread" ||
          param.callback.params.some(
            (p) => typeof p !== "string" || ["cstring", "string", "bytes"].includes(p),
          ) ||
          entry.returns !== "pointer" ||
          entry.callbackTarget !== undefined
        )
          fail("has an invalid registration ABI");
      } else if (entry.callbackOperation === "release") {
        const target = entry.callbackTarget ? ffiByName.get(entry.callbackTarget) : undefined;
        if (
          entry.params.length !== 0 ||
          entry.returns !== "void" ||
          target?.callbackOperation !== "register" ||
          target.library !== entry.library
        )
          fail("has an invalid release target or ABI");
      } else fail("has an invalid operation");
    } else if (entry.callbackTarget !== undefined) {
      errors.push({
        message: `FFI binding "${entry.name}" has a callback target without a release operation`,
        loc: moduleLoc,
      });
    }
    const ids = new Set<string>();
    for (const param of entry.params) {
      if (!isFfiCallbackParam(param)) continue;
      if (ids.has(param.callback.id)) {
        errors.push({
          message: `FFI binding "${entry.name}" has duplicate callback id "${param.callback.id}"`,
          loc: moduleLoc,
        });
      }
      ids.add(param.callback.id);
      if (param.callback.invoke !== "script-thread" && param.callback.invoke !== "foreign") {
        errors.push({
          message: `FFI callback "${entry.name}:${param.callback.id}" has invalid invoke mode`,
          loc: moduleLoc,
        });
      }
      if (param.callback.invoke === "foreign") {
        if (param.callback.params.some((p) => p === "i64" || p === "u64" || p === "pointer")) {
          errors.push({
            message: `FFI foreign callback "${entry.name}:${param.callback.id}" has unsupported 64-bit or pointer arguments`,
            loc: moduleLoc,
          });
        }
        if (param.callback.lifetime !== "retained") {
          errors.push({
            message: `FFI foreign callback "${entry.name}:${param.callback.id}" is not retained`,
            loc: moduleLoc,
          });
        }
        if (param.callback.returns !== "void") {
          errors.push({
            message: `FFI foreign callback "${entry.name}:${param.callback.id}" does not return void`,
            loc: moduleLoc,
          });
        }
        if (!param.callback.params.some(isFfiContextParam)) {
          errors.push({
            message: `FFI foreign callback "${entry.name}:${param.callback.id}" has no context`,
            loc: moduleLoc,
          });
        }
      }
      if (param.callback.lifetime === "retained") {
        retainedFfiCallbacks.set(`${entry.name}:${param.callback.id}`, param.callback);
      }
      const hasInnerContext = param.callback.params.some(isFfiContextParam);
      const outerContexts = entry.params.filter(
        (candidate) => isFfiContextParam(candidate) && candidate.context === param.callback.id,
      ).length;
      if (hasInnerContext !== (outerContexts === 1)) {
        errors.push({
          message: `FFI callback "${entry.name}:${param.callback.id}" has inconsistent context slots`,
          loc: moduleLoc,
        });
      }
    }
  }
  for (const entry of mod.ffiImports ?? []) {
    for (const param of entry.params) {
      if (!isFfiReleaseParam(param)) continue;
      const target = retainedFfiCallbacks.get(param.callback.release);
      if (target === undefined) {
        errors.push({
          message: `FFI release "${entry.name}:${param.callback.release}" has no retained target`,
          loc: moduleLoc,
        });
        continue;
      }
      // A call registering its own release target defeats the emitted
      // pin -> require -> call -> commit -> release ordering (the loader
      // rejects this shape; mirrored here for deserialized IR).
      const registeredBySameCall = entry.params.some(
        (candidate) =>
          isFfiCallbackParam(candidate) &&
          `${entry.name}:${candidate.callback.id}` === param.callback.release,
      );
      if (registeredBySameCall) {
        errors.push({
          message: `FFI release "${entry.name}:${param.callback.release}" targets a retained callback registered by the same call`,
          loc: moduleLoc,
        });
      }
      // Structural ABI comparison: a params entry is a value-class string
      // or a {context} object. Key order and incidental object shape must
      // not matter — a producer that rebuilds these arrays (deserialized
      // IR, a second frontend) still validates.
      const inherited =
        param.callback.params.length === target.params.length &&
        param.callback.params.every((entry, i) => {
          const other = target.params[i]!;
          return isFfiContextParam(entry)
            ? isFfiContextParam(other) && entry.context === other.context
            : entry === other;
        }) &&
        param.callback.returns === target.returns;
      if (!inherited) {
        errors.push({
          message: `FFI release "${entry.name}:${param.callback.release}" does not inherit its target ABI`,
          loc: moduleLoc,
        });
      }
      const hasInnerContext = target.params.some(isFfiContextParam);
      const outerContexts = entry.params.filter(
        (candidate) => isFfiContextParam(candidate) && candidate.context === param.callback.release,
      ).length;
      if (hasInnerContext !== (outerContexts === 1)) {
        errors.push({
          message: `FFI release "${entry.name}:${param.callback.release}" has inconsistent context slots`,
          loc: moduleLoc,
        });
      }
    }
  }
  // The lib section (library mode): every mapped function exists, is
  // synchronous, and its IR signature fits the declared marshalling
  // classes — the SC4xxx refusals ran before this landed on the module, so
  // a violation here is a compiler bug like any other validation error.
  if (mod.lib !== undefined) {
    const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
    for (const e of mod.lib.exports) {
      const fn = functionsByName.get(e.fnName);
      if (!fn) {
        errors.push({
          message: `library export "${e.symbol}": missing function "${e.fnName}"`,
          loc: entryLoc,
        });
        continue;
      }
      if (fn.async === true || fn.generator !== undefined) {
        errors.push({
          message: `library export "${e.symbol}": "${e.fnName}" is async/generator`,
          loc: fn.loc,
        });
      }
      if (fn.captures !== undefined) {
        errors.push({
          message: `library export "${e.symbol}": "${e.fnName}" captures an environment`,
          loc: fn.loc,
        });
      }
      if (fn.params.length !== e.params.length) {
        errors.push({
          message: `library export "${e.symbol}": ${e.params.length} marshalling classes over ${fn.params.length} params`,
          loc: fn.loc,
        });
        continue;
      }
      const fits = (cls: string, t: IrType): boolean =>
        cls === "bool"
          ? t.kind === "bool"
          : cls === "string"
            ? t.kind === "string"
            : cls === "bytes"
              ? t.kind === "bytes" && t.elem === "u8"
              : t.kind === "f64"; // f64 + the integer plumbing classes
      e.params.forEach((cls, i) => {
        if (!fits(cls, fn.params[i]!.type)) {
          errors.push({
            message: `library export "${e.symbol}": param ${i} class "${cls}" over IR type "${fn.params[i]!.type.kind}"`,
            loc: fn.loc,
          });
        }
      });
      if (e.returns === "void" ? fn.returnType.kind !== "void" : !fits(e.returns, fn.returnType)) {
        errors.push({
          message: `library export "${e.symbol}": return class "${e.returns}" over IR type "${fn.returnType.kind}"`,
          loc: fn.loc,
        });
      }
    }
    if (!functionsByName.has(mod.entry)) {
      errors.push({
        message: `library module missing its entry function "${mod.entry}"`,
        loc: entryLoc,
      });
    }
    // Host-callback channels: the register symbol and the channel list are
    // paired (the profile loader refuses otherwise, so a miss here is a
    // compiler bug), slots are the declaration order, and every channel
    // has its matching ffiImport (the lowering recognizes calls by it).
    const cbs = mod.lib.callbacks ?? [];
    if (cbs.length > 0 !== (mod.lib.callbackRegisterSymbol !== undefined)) {
      errors.push({
        message: "library callbacks and callbackRegisterSymbol must be present together",
        loc: entryLoc,
      });
    }
    const cbNames = new Set<string>();
    cbs.forEach((cb, i) => {
      if (cb.slot !== i) {
        errors.push({
          message: `library callback "${cb.name}": slot ${cb.slot} out of declaration order (expected ${i})`,
          loc: entryLoc,
        });
      }
      if (cbNames.has(cb.name)) {
        errors.push({ message: `duplicate library callback channel "${cb.name}"`, loc: entryLoc });
      }
      cbNames.add(cb.name);
      if (!(mod.ffiImports ?? []).some((f) => f.name === cb.name)) {
        errors.push({
          message: `library callback "${cb.name}" has no matching ffiImport`,
          loc: entryLoc,
        });
      }
    });
  }
  const classesByName = new Map<string, IrClassDef>();
  const classFields = new Map<string, Map<string, IrType>>();
  for (const cls of mod.classes ?? []) {
    if (classesByName.has(cls.name)) {
      errors.push({ message: `duplicate class "${cls.name}"`, loc: cls.loc });
    }
    classesByName.set(cls.name, cls);
    if (cls.localCaptures !== undefined && (cls.runtime || cls.genericOf !== undefined)) {
      errors.push({
        message: `class ${cls.name}: local class cannot use a runtime or generic family layout`,
        loc: cls.loc,
      });
    }
    if (cls.localCaptures !== undefined) {
      const environment = cls.fields.find(
        (field) => field.name === `%classEnvironment:${cls.name}`,
      );
      if (environment?.type.kind !== "classval" || environment.type.className !== cls.name) {
        errors.push({
          message: `class ${cls.name}: local class requires its constructor environment field`,
          loc: cls.loc,
        });
      }
    }
    if (cls.localBaseCapture !== undefined) {
      const base = cls.localCaptures?.[cls.localBaseCapture];
      if (
        !Number.isInteger(cls.localBaseCapture) ||
        base?.type.kind !== "classval" ||
        base.type.className !== cls.base
      ) {
        errors.push({ message: `class ${cls.name}: invalid local base capture`, loc: cls.loc });
      }
    }
    if (cls.baseValueGlobal !== undefined) {
      const global = mod.globals?.find((global) => global.id === cls.baseValueGlobal);
      if (
        cls.localBaseCapture !== undefined ||
        !cls.base ||
        global?.type.kind !== "classval" ||
        global.type.className !== cls.base
      ) {
        errors.push({ message: `class ${cls.name}: invalid computed base global`, loc: cls.loc });
      }
    }
    if (cls.jsLength !== undefined && (!Number.isSafeInteger(cls.jsLength) || cls.jsLength < 0)) {
      errors.push({ message: `class ${cls.name}: invalid constructor length`, loc: cls.loc });
    }
    if (
      cls.tracksOwnFields &&
      (cls.runtime ||
        cls.fields.find((field) => field.name === DYN_CLASS_PROPERTIES)?.type.kind !== "dyn")
    ) {
      errors.push({
        message: `class ${cls.name}: field presence tracking requires a native dyn property bag`,
        loc: cls.loc,
      });
    }
    if (cls.prototypeDataHelper !== undefined) {
      const helper = functionsByName.get(cls.prototypeDataHelper);
      if (
        !helper ||
        helper.params.length !== 0 ||
        helper.returnType.kind !== "dyn" ||
        helper.captures !== undefined ||
        helper.classCaptures !== undefined
      ) {
        errors.push({
          message: `class ${cls.name}: prototype data helper must be a noncapturing () => dyn function`,
          loc: cls.loc,
        });
      }
    }
    if (cls.instancePrototypeHelper !== undefined) {
      const helper = functionsByName.get(cls.instancePrototypeHelper);
      const receiver = helper?.params[0]?.type;
      if (
        !helper ||
        helper.params.length !== 1 ||
        receiver?.kind !== "object" ||
        receiver.className !== cls.name ||
        helper.returnType.kind !== "dyn" ||
        helper.captures !== undefined ||
        helper.classCaptures !== undefined
      ) {
        errors.push({
          message: `class ${cls.name}: instance prototype helper must be a noncapturing (instance) => dyn function`,
          loc: cls.loc,
        });
      }
    }
    for (const symbol of cls.symbolFields ?? []) {
      const global = mod.globals?.find((global) => global.id === symbol.globalId);
      if (
        global?.type.kind !== "symbol" ||
        !cls.fields.some((field) => field.name === symbol.field)
      ) {
        errors.push({ message: `class ${cls.name}: invalid symbol field metadata`, loc: cls.loc });
      }
    }
    // Reuse duplicate detection as the field index for function validation.
    // Array.find selected the first field, even in an invalid duplicate layout.
    const seen = new Map<string, IrType>();
    for (const f of cls.fields) {
      if (seen.has(f.name)) {
        errors.push({ message: `class ${cls.name}: duplicate field "${f.name}"`, loc: cls.loc });
      } else seen.set(f.name, f.type);
      if (isUnitType(f.type)) {
        errors.push({
          message: `class ${cls.name}: field "${f.name}" is ${f.type.kind}`,
          loc: cls.loc,
        });
      }
    }
    // Duplicate class names, like classesByName, select the last declaration.
    if (seen.size > 0) classFields.set(cls.name, seen);
    else classFields.delete(cls.name);
    // Constructor presence is checked at `new` sites (below): a class kept
    // only for its layout/type (reachability never constructs it) carries
    // no constructor function, and that is fine — nothing calls it.
    // ABSTRACT entries are declarations without bodies by definition — no
    // module function exists for them (and must not).
    for (const m of cls.abstractMethods ?? []) {
      if (!cls.methods?.includes(m)) {
        errors.push({
          message: `class ${cls.name}: abstract method "${m}" not in methods`,
          loc: cls.loc,
        });
      }
      if (functionsByName.has(`%${cls.name}.${m}`)) {
        errors.push({
          message: `class ${cls.name}: abstract method "${m}" has a function`,
          loc: cls.loc,
        });
      }
    }
    for (const m of cls.methods ?? []) {
      if (cls.abstractMethods?.includes(m)) continue;
      if (!functionsByName.has(`%${cls.name}.${m}`)) {
        errors.push({ message: `class ${cls.name}: missing method function "${m}"`, loc: cls.loc });
      }
    }
  }
  // Hierarchy invariants: bases exist, the graph is acyclic, and every
  // derived class's field list starts with its base's EXACTLY (the prefix
  // layout that makes upcasts pointer reinterprets).
  for (const cls of mod.classes ?? []) {
    if (cls.base === undefined) continue;
    const base = classesByName.get(cls.base);
    if (!base) {
      errors.push({ message: `class ${cls.name}: undeclared base "${cls.base}"`, loc: cls.loc });
      continue;
    }
    if (
      base.localCaptures !== undefined &&
      cls.localBaseCapture === undefined &&
      cls.baseValueGlobal === undefined
    ) {
      errors.push({
        message: `class ${cls.name}: local base requires a captured constructor`,
        loc: cls.loc,
      });
    }
    const seen = new Set<string>([cls.name]);
    for (
      let c: IrClassDef | undefined = base;
      c;
      c = c.base !== undefined ? classesByName.get(c.base) : undefined
    ) {
      if (seen.has(c.name)) {
        errors.push({ message: `class ${cls.name}: cyclic extends chain`, loc: cls.loc });
        break;
      }
      seen.add(c.name);
    }
    if (
      cls.fields.length < base.fields.length ||
      base.fields.some(
        (f, i) => cls.fields[i]!.name !== f.name || !typeEquals(cls.fields[i]!.type, f.type),
      )
    ) {
      errors.push({
        message: `class ${cls.name}: fields are not a layout extension of base "${cls.base}"`,
        loc: cls.loc,
      });
    }
  }
  // Family membership is nominal; an instance may have a separately
  // specialized base. The family's inherited prefix must remain valid.
  const physicalRoot = (cls: IrClassDef): IrClassDef | undefined => {
    const seen = new Set<string>();
    let current: IrClassDef | undefined = cls;
    while (current?.base !== undefined) {
      if (seen.has(current.name)) return undefined;
      seen.add(current.name);
      current = classesByName.get(current.base);
    }
    return current;
  };
  for (const cls of mod.classes ?? []) {
    if (cls.genericOf === undefined) continue;
    const family = classesByName.get(cls.genericOf);
    if (!family) {
      errors.push({
        message: `class ${cls.name}: undeclared generic family "${cls.genericOf}"`,
        loc: cls.loc,
      });
    } else if (family === cls || family.genericOf !== undefined) {
      errors.push({
        message: `class ${cls.name}: generic family "${cls.genericOf}" must name an erased declaration`,
        loc: cls.loc,
      });
    } else if (physicalRoot(cls) !== physicalRoot(family)) {
      errors.push({
        message: `class ${cls.name}: generic family "${cls.genericOf}" has a different storage root`,
        loc: cls.loc,
      });
    } else if (
      family.fields.some(
        (field, index) =>
          cls.fields[index]?.name !== field.name ||
          !typeEquals(cls.fields[index]!.type, field.type),
      )
    ) {
      errors.push({
        message: `class ${cls.name}: generic family "${cls.genericOf}" has an incompatible prefix`,
        loc: cls.loc,
      });
    }
  }
  const noLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const recordsById = new Map<string, IrRecordShape>();
  const recordIds = new Set((mod.records ?? []).map((record) => record.id));
  const recordValidation = new Map<string, RecordValidation>();
  for (const rec of mod.records ?? []) {
    if (recordsById.has(rec.id)) {
      errors.push({ message: `duplicate record shape "${rec.id}"`, loc: noLoc });
    }
    recordsById.set(rec.id, rec);
    const fields = new Map<string, IrType>();
    for (const f of rec.fields) {
      if (fields.has(f.name)) {
        errors.push({ message: `record ${rec.id}: duplicate field "${f.name}"`, loc: noLoc });
      } else fields.set(f.name, f.type);
      // Unit kinds (undefinedT/nullT) exist only as union arms — a BARE
      // unit field is as malformed as a void one. dyn and jsval slots
      // are valid; both are refcounted values held by the record shape.
      if (f.type.kind === "void" || isUnitType(f.type)) {
        errors.push({
          message: `record ${rec.id}: field "${f.name}" is ${f.type.kind}`,
          loc: noLoc,
        });
      }
      if (f.type.kind === "record" && !recordIds.has(f.type.shapeId)) {
        errors.push({
          message: `record ${rec.id}: field "${f.name}" references undeclared shape "${f.type.shapeId}"`,
          loc: noLoc,
        });
      }
    }
    // Reads historically use the first duplicate field, while literal and
    // clone checks use the last. Preserve both on malformed shapes; valid
    // shapes share one index. All indexes belong to this validation call.
    recordValidation.set(rec.id, {
      fields,
      initializationFields:
        fields.size === rec.fields.length
          ? fields
          : new Map(rec.fields.map((field) => [field.name, field.type])),
      hasAccessorSlots: shapeHasAccessorSlots(rec),
    });
    // Canonical order is the shape's identity — enforce it.
    const sorted = [...rec.fields].map((f) => f.name).sort();
    if (rec.fields.some((f, i) => f.name !== sorted[i])) {
      errors.push({
        message: `record ${rec.id}: fields are not in canonical (sorted) order`,
        loc: noLoc,
      });
    }
    // Tuple shapes carry exactly the positional fields "0".."n-1" (arity =
    // field count) — anything else has no honest index/JSON story.
    if (rec.tuple) {
      const names = new Set(rec.fields.map((f) => f.name));
      let positionsComplete = true;
      for (let i = 0; i < rec.fields.length; i++) {
        if (!names.has(String(i))) {
          positionsComplete = false;
          break;
        }
      }
      if (rec.fields.length === 0 || names.size !== rec.fields.length || !positionsComplete) {
        errors.push({
          message: `record ${rec.id}: tuple fields are not "0".."${rec.fields.length - 1}"`,
          loc: noLoc,
        });
      }
      if (rec.indexValue) {
        errors.push({
          message: `record ${rec.id}: a tuple cannot carry an index signature`,
          loc: noLoc,
        });
      }
    }
    // Index-signature shapes: the overflow value type is fenced to the map
    // VALUE kinds plus dyn (`unknown` signatures) — isSupportedIndexValue.
    if (rec.indexValue && !isSupportedIndexValue(rec.indexValue)) {
      errors.push({
        message: `record ${rec.id}: index-signature value type ${rec.indexValue.kind} is unsupported`,
        loc: noLoc,
      });
    }
  }
  const unionsById = new Map<string, IrUnionDef>();
  for (const u of mod.unions ?? []) {
    if (unionsById.has(u.id)) {
      errors.push({ message: `duplicate union "${u.id}"`, loc: noLoc });
    }
    unionsById.set(u.id, u);
  }
  for (const u of mod.unions ?? []) {
    if (u.arms.length < 2) {
      errors.push({ message: `union ${u.id}: fewer than 2 arms`, loc: noLoc });
    }
    if (u.discriminant) {
      const { field, cases } = u.discriminant;
      const tags = new Set<number>();
      const values = new Set<string>();
      for (const candidate of cases) {
        const arm = u.arms[candidate.tag];
        const record = arm?.kind === "record" ? recordsById.get(arm.shapeId) : undefined;
        const member = record ? recordValidation.get(record.id)?.fields.get(field) : undefined;
        if (
          !Number.isInteger(candidate.tag) ||
          candidate.tag < 0 ||
          !member ||
          tags.has(candidate.tag)
        ) {
          errors.push({
            message: `union ${u.id}: invalid discriminant tag ${candidate.tag}`,
            loc: noLoc,
          });
        }
        tags.add(candidate.tag);
        if (candidate.values.length === 0) {
          errors.push({
            message: `union ${u.id}: empty discriminant values for tag ${candidate.tag}`,
            loc: noLoc,
          });
        }
        for (const value of candidate.values) {
          if (value === undefined) {
            errors.push({ message: `union ${u.id}: undefined discriminant value`, loc: noLoc });
            continue;
          }
          const fieldTypes =
            member?.kind === "union"
              ? (unionsById.get(member.unionId)?.arms ?? [])
              : member
                ? [member]
                : [];
          const valid = fieldTypes.some((type) =>
            typeof value === "string"
              ? type.kind === "string"
              : typeof value === "boolean"
                ? type.kind === "bool"
                : typeof value === "number" && Number.isFinite(value) && type.kind === "f64",
          );
          const key = typeof value + ":" + String(value);
          if (!valid || values.has(key)) {
            errors.push({
              message: `union ${u.id}: invalid or repeated discriminant value ${key}`,
              loc: noLoc,
            });
          }
          values.add(key);
        }
      }
      for (let tag = 0; tag < u.arms.length; tag++) {
        if (u.arms[tag]!.kind === "record" && !tags.has(tag)) {
          errors.push({
            message: `union ${u.id}: missing discriminant for record arm ${tag}`,
            loc: noLoc,
          });
        }
      }
    }
    u.arms.forEach((arm, i) => {
      // The unit kinds (undefinedT/nullT) are valid arms — union membership
      // is the ONLY place they may appear. Container payloads preserve
      // identity; promise data siblings retain their separate fence.
      if (
        arm.kind === "void" ||
        arm.kind === "union" ||
        arm.kind === "dyn" ||
        arm.kind === "jsval" ||
        arm.kind === "date" ||
        arm.kind === "generator"
      ) {
        errors.push({ message: `union ${u.id}: arm ${i} is ${arm.kind}`, loc: noLoc });
      }
      if (arm.kind === "promise" && !unionContainerArmsOk(u.arms)) {
        errors.push({
          message: `union ${u.id}: ${arm.kind} arm ${i} beside non-unit arms`,
          loc: noLoc,
        });
      }
      if (arm.kind === "record" && !recordsById.has(arm.shapeId)) {
        errors.push({
          message: `union ${u.id}: arm ${i} references undeclared shape "${arm.shapeId}"`,
          loc: noLoc,
        });
      }
      // classval arms may name UNDECLARED classes: the payload emits as
      // the class-independent `ScrClassObj *` (see the namesUndeclared
      // backstop below) — a fenced class's value slot is inert-but-valid.
      for (let j = i + 1; j < u.arms.length; j++) {
        if (typeEquals(arm, u.arms[j]!)) {
          errors.push({ message: `union ${u.id}: arms ${i} and ${j} are identical`, loc: noLoc });
        }
      }
    });
  }
  const globalsById = new Map((mod.globals ?? []).map((g) => [g.id, g]));
  // Every class an emitted type slot names as an OBJECT type must be
  // DECLARED: the emitter writes the class's own struct type and typed
  // retain/release calls for such slots, so an unregistered class there
  // is invalid C waiting to happen (the compile-C escape family — a JS
  // class whose collection fenced, with the object-typed slot left
  // behind; run() prunes the dead ones, and this is the backstop that
  // turns any live escape into an ICE instead of a clang error). CLASSVAL
  // types are exempt: every class value emits as the one class-independent
  // `ScrClassObj *` (constructing/dispatching through it re-resolves the
  // class and carries its own lowering-time fence), so a classval naming
  // a fenced class is inert-but-valid storage, the honest leftovers of a
  // runtime-fenced declaration.
  const namesUndeclared = (t: IrType, seen: Set<string>): string | null => {
    switch (t.kind) {
      case "object":
        return classesByName.has(t.className) ? null : t.className;
      case "array":
      case "set":
        return namesUndeclared(t.elem, seen);
      case "map":
        return namesUndeclared(t.key, seen) ?? namesUndeclared(t.value, seen);
      case "promise":
        return namesUndeclared(t.inner, seen);
      case "generator":
        return (
          namesUndeclared(t.yieldT, seen) ??
          namesUndeclared(t.retT, seen) ??
          namesUndeclared(t.nextT, seen)
        );
      case "func":
        for (const p of t.params) {
          const hit = namesUndeclared(p, seen);
          if (hit) return hit;
        }
        return namesUndeclared(t.ret, seen);
      case "record": {
        if (seen.has(t.shapeId)) return null;
        seen.add(t.shapeId);
        const rec = recordsById.get(t.shapeId);
        if (!rec) return null; // its own undeclared-shape check reports
        if (rec.indexValue) {
          const hit = namesUndeclared(rec.indexValue, seen);
          if (hit) return hit;
        }
        for (const f of rec.fields) {
          const hit = namesUndeclared(f.type, seen);
          if (hit) return hit;
        }
        return null;
      }
      case "union": {
        if (seen.has(t.unionId)) return null;
        seen.add(t.unionId);
        const def = unionsById.get(t.unionId);
        if (!def) return null;
        for (const a of def.arms) {
          const hit = namesUndeclared(a, seen);
          if (hit) return hit;
        }
        return null;
      }
      default:
        return null;
    }
  };
  for (const g of mod.globals ?? []) {
    if (g.tdz && g.type.kind !== "record" && g.type.kind !== "func" && g.type.kind !== "dyn") {
      errors.push({
        message: `TDZ global "${g.name}" must have record, function, or checked-value storage`,
        loc: noLoc,
      });
    }
    if (isUnitType(g.type)) {
      errors.push({ message: `global "${g.name}" has bare unit type ${g.type.kind}`, loc: noLoc });
    }
    if (!g.id.startsWith("%g.")) {
      errors.push({
        message: `global "${g.name}" id "${g.id}" outside the %g. namespace`,
        loc: { file: mod.sourceFile, start: 0, end: 0 },
      });
    }
    const undeclared = namesUndeclared(g.type, new Set());
    if (undeclared !== null) {
      errors.push({
        message: `global "${g.name}" names undeclared class "${undeclared}"`,
        loc: noLoc,
      });
    }
  }
  // The same backstop over class LAYOUTS: a field typed by an undeclared
  // class emits that class's struct type and release call into the TU —
  // the exact invalid-C escape the global check catches, one level deeper
  // (the anonymous-CJS-export shape reached emission through a class
  // FIELD, never a global). Function locals and returns stay UNCHECKED:
  // a local typed by an uncollected class is a pinned-valid module state
  // (the runtime-fenced-JS-class story — captured locals emit inert
  // trapping boxes; see boxNewC's uncollected-class placeholder), where a
  // field slot embeds the raw struct pointer and has no degradation.
  for (const cls of mod.classes ?? []) {
    for (const f of cls.fields) {
      const undeclared = namesUndeclared(f.type, new Set());
      if (undeclared !== null) {
        errors.push({
          message: `class ${cls.name}: field "${f.name}" names undeclared class "${undeclared}"`,
          loc: cls.loc,
        });
      }
    }
  }
  // Class metadata is invariant across functions. Keep field lookup, hierarchy
  // membership, and virtual-call resolution local to this validation invocation.
  const classValidation: ClassValidation = {
    fields: classFields,
    hierarchy: new Set(),
    implementations: new Map(),
    virtualCalls: new Map(),
  };
  for (const cls of classesByName.values()) {
    if (cls.base !== undefined) {
      classValidation.hierarchy.add(cls.name);
      classValidation.hierarchy.add(cls.base);
    }
    if (cls.name === RUNTIME_EMITTER_CLASS) classValidation.hierarchy.add(cls.name);
    for (const method of new Set(cls.methods ?? [])) {
      if (cls.abstractMethods?.includes(method)) continue;
      let implementations = classValidation.implementations.get(method);
      if (!implementations) classValidation.implementations.set(method, (implementations = []));
      implementations.push(cls);
    }
  }
  for (const fn of mod.functions) {
    validateFunction(
      fn,
      functionsByName,
      ffiByName,
      classesByName,
      recordsById,
      recordValidation,
      unionsById,
      globalsById,
      classValidation,
      errors,
      mod.workers === true,
    );
  }
  return errors;
}

function validateFunction(
  fn: IrFunction,
  functions: Map<string, IrFunction>,
  ffiByName: Map<string, NonNullable<IrModule["ffiImports"]>[number]>,
  classes: Map<string, IrClassDef>,
  records: Map<string, IrRecordShape>,
  recordValidation: Map<string, RecordValidation>,
  unions: Map<string, IrUnionDef>,
  globals: Map<string, IrGlobal>,
  classValidation: ClassValidation,
  errors: IrValidationError[],
  workers: boolean,
): void {
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const err = (message: string, loc: SrcLoc) =>
    errors.push({ message: `in ${fn.name}: ${message}`, loc });

  const asyncCaches = [
    ["asyncCacheGlobal", fn.asyncCacheGlobal],
    ["asyncCycleCacheGlobal", fn.asyncCycleCacheGlobal],
  ] as const;
  for (const [field, cacheId] of asyncCaches) {
    if (cacheId === undefined) continue;
    if (fn.async !== true) {
      err(`an ${field} is only valid on an async function`, fn.loc);
    }
    if (fn.params.length !== 0 || (fn.captures?.length ?? 0) !== 0) {
      err("a cached async function must have no parameters or captures", fn.loc);
    }
    const cache = globals.get(cacheId);
    if (cache === undefined) {
      err(`async cache names undeclared global "${cacheId}"`, fn.loc);
    } else {
      const expected: IrType = { kind: "promise", inner: fn.returnType };
      if (!typeEquals(cache.type, expected)) {
        err(
          `async cache global "${cacheId}" has type ${typeKey(cache.type)}, expected ${typeKey(expected)}`,
          fn.loc,
        );
      }
      if (!cache.mutable) {
        err(`async cache global "${cacheId}" is immutable`, fn.loc);
      }
    }
  }
  if (fn.asyncCycleCacheGlobal !== undefined && fn.asyncCacheGlobal === undefined) {
    err("an asyncCycleCacheGlobal requires a module asyncCacheGlobal", fn.loc);
  }

  // Virtual slots and constructor ABIs follow physical inheritance only.
  // Erased family identity does not supply their specialized layout or ABI.
  const isPhysicalSubclass = (sub: string, sup: string): boolean => {
    const seen = new Set<string>([sub]);
    for (let c = classes.get(sub)?.base; c !== undefined; c = classes.get(c)?.base) {
      if (seen.has(c)) return false;
      seen.add(c);
      if (c === sup) return true;
    }
    return false;
  };
  // Object casts may also recover an erased family. The module-level
  // prefix check validates the fields exposed by that view.
  const isStrictSubclass = (sub: string, sup: string): boolean => {
    const seen = new Set<string>();
    for (let c = classes.get(sub); c; c = c.base === undefined ? undefined : classes.get(c.base)) {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      if (c.name !== sub && c.name === sup) return true;
      const families = new Set<string>();
      for (
        let family = c.genericOf === undefined ? undefined : classes.get(c.genericOf);
        family;
        family = family.base === undefined ? undefined : classes.get(family.base)
      ) {
        if (families.has(family.name)) return false;
        families.add(family.name);
        if (family.name === sup) return true;
      }
    }
    return false;
  };
  const hierarchy = classValidation.hierarchy;
  const virtualCallInfo = (className: string, method: string): VirtualCallInfo => {
    let methods = classValidation.virtualCalls.get(className);
    const cached = methods?.get(method);
    if (cached) return cached;
    if (!methods) classValidation.virtualCalls.set(className, (methods = new Map()));
    let declared = false;
    let implementation: IrFunction | undefined;
    for (
      let c = classes.get(className);
      c;
      c = c.base !== undefined ? classes.get(c.base) : undefined
    ) {
      if (c.methods?.includes(method)) {
        declared = true;
        if (!c.abstractMethods?.includes(method)) {
          implementation = functions.get(`%${c.name}.${method}`);
          break;
        }
      }
    }
    let hasOverride = false;
    if (declared) {
      // Preserve class-table order when choosing an abstract slot's ABI.
      for (const c of classValidation.implementations.get(method) ?? []) {
        if (!isPhysicalSubclass(c.name, className)) continue;
        hasOverride = true;
        implementation ??= functions.get(`%${c.name}.${method}`);
        if (implementation) break;
      }
    }
    const result = { declared, hasOverride, implementation };
    methods.set(method, result);
    return result;
  };

  // Unit kinds live only inside unions: a bare-unit local, param, or
  // return type is frontend breakage (mapType never produces them).
  for (const l of fn.locals) {
    if (l.tdz && !l.boxed) err(`TDZ local "${l.name}" must be boxed`, fn.loc);
    if (isUnitType(l.type)) err(`local "${l.name}" has bare unit type ${l.type.kind}`, fn.loc);
  }
  if (isUnitType(fn.returnType)) {
    err(`return type is bare unit type ${fn.returnType.kind}`, fn.loc);
  }
  // Exception snapshots may be captured or passed to internal conversion
  // helpers. They are not source-level types and never return as values.
  if (fn.returnType.kind === "caught") err("return type is caught", fn.loc);
  for (const p of fn.params) {
    if (p.type.kind === "caught" && fn.name !== "%caught.dynamicValue")
      err(`param "${p.name}" is caught-typed`, fn.loc);
    if (!locals.has(p.localId)) {
      err(`param "${p.name}" has no local entry "${p.localId}"`, fn.loc);
    }
  }
  for (const c of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])]) {
    const local = locals.get(c.localId);
    if (!local) err(`capture "${c.name}" has no local entry "${c.localId}"`, fn.loc);
    else if (!local.boxed) err(`capture local "${c.localId}" is not boxed`, fn.loc);
    else if (!typeEquals(local.type, c.type))
      err(`capture local "${c.localId}" has the wrong type`, fn.loc);
  }
  if (fn.classCaptures !== undefined) {
    const self = fn.params[0];
    const cls = self?.type.kind === "object" ? classes.get(self.type.className) : undefined;
    if (fn.captures !== undefined || cls?.localCaptures === undefined) {
      err(
        "class captures require a local-class instance receiver and no closure environment",
        fn.loc,
      );
    }
    for (const capture of fn.classCaptures) {
      const slot = cls?.localCaptures?.[capture.slot];
      if (!Number.isInteger(capture.slot) || !slot || !typeEquals(slot.type, capture.type)) {
        err(`class capture "${capture.name}" has an invalid slot or type`, fn.loc);
      }
    }
  }

  const expectType = (expr: IrExpr, want: IrType, what: string) => {
    if (!typeEquals(expr.type, want)) {
      // Same-kind mismatches (func vs func, record vs record) would be
      // unreadable as bare kinds — the structural keys show WHERE the two
      // types diverge.
      const detail =
        want.kind === expr.type.kind
          ? ` (expected ${typeKey(want)}, got ${typeKey(expr.type)})`
          : "";
      err(`${what}: expected ${want.kind}, got ${expr.type.kind}${detail}`, expr.loc);
    }
  };

  /** Union arms a truthiness helper can answer: units (false), scalars and
   * strings (per-value), ref kinds (always true), jsval (the engine
   * answers). dyn/caught arms have no ToBoolean — the frontend fences them
   * before emitting toBool/logical over the union. */
  const checkTruthyUnion = (unionId: string, loc: SrcLoc) => {
    const def = unions.get(unionId);
    if (!def) {
      err(`truthiness of unknown union ${unionId}`, loc);
      return;
    }
    for (const arm of def.arms) {
      if (arm.kind === "dyn" || arm.kind === "caught" || arm.kind === "void") {
        err(`truthiness of union with ${arm.kind} arm`, loc);
      }
    }
  };

  // Optional chains open a binding scope: chainRecv is valid only inside
  // the body of the optChain whose id it names.
  const activeChains = new Map<string, IrType>();

  const liveDynRefEligible = (type: IrType, seen = new Set<string>()): boolean => {
    if (
      type.kind === "record" ||
      type.kind === "array" ||
      type.kind === "bytes" ||
      isDynTypedRefType(type)
    ) {
      return true;
    }
    if (type.kind !== "union" || seen.has(type.unionId)) return false;
    seen.add(type.unionId);
    return unions.get(type.unionId)?.arms.some((arm) => liveDynRefEligible(arm, seen)) ?? false;
  };

  function checkNullishOperands(e: IrExpr & { kind: "nullish" }): void {
    expectType(e.right, e.type, "nullish right operand");
    // The ISLAND form: `a ?? b` over an engine value — left, right,
    // and result are all handles (the emitters' jsval nullish arm).
    if (e.left.type.kind === "jsval") {
      if (e.type.kind !== "jsval") err("jsval nullish must answer jsval", e.loc);
      return;
    }
    // The CHECKED-DYNAMIC form: the runtime kind decides (the
    // emitters' scr_dyn_is_nullish arm) — left, right, and result
    // all live in the checked-dynamic tree.
    if (e.left.type.kind === "dyn") {
      if (e.type.kind !== "dyn") err("dyn nullish must answer dyn", e.loc);
      return;
    }
    if (e.left.type.kind !== "union") {
      err(`nullish left must be a union, got ${e.left.type.kind}`, e.loc);
      return;
    }
    const def = unions.get(e.left.type.unionId);
    if (!def) {
      err(`nullish left references unknown union ${e.left.type.unionId}`, e.loc);
      return;
    }
    if (!def.arms.some(isUnitType)) {
      err("nullish left union has no unit arm (frontend must fence)", e.loc);
    }
    // Two shapes: pass-through (type === left's union) or narrowed
    // (type === the union's SINGLE non-unit arm).
    if (!typeEquals(e.type, e.left.type)) {
      const rest = def.arms.filter((a) => !isUnitType(a));
      if (rest.length !== 1 || !typeEquals(e.type, rest[0]!)) {
        err("nullish type must be the left union or its single non-unit arm", e.loc);
      }
    }
  }

  function checkBranchingTree(root: IrExpr): void {
    // Predicates and conditional dispatch can nest in either direction.
    // Preserve child-before-parent diagnostics with bounded native stack
    // use, including trees that mix the three branching operators.
    const pending: { expr: IrExpr; visited: boolean }[] = [{ expr: root, visited: false }];
    while (pending.length !== 0) {
      const task = pending.pop()!;
      const e = task.expr;
      if (!task.visited) {
        if (e.kind === "logical" || e.kind === "nullish") {
          pending.push({ expr: e, visited: true });
          pending.push({ expr: e.right, visited: false });
          pending.push({ expr: e.left, visited: false });
        } else if (e.kind === "ternary") {
          pending.push({ expr: e, visited: true });
          pending.push({ expr: e.else_, visited: false });
          pending.push({ expr: e.then, visited: false });
          pending.push({ expr: e.cond, visited: false });
        } else {
          checkExpr(e);
        }
        continue;
      }
      if (e.kind === "logical") {
        if (
          e.type.kind !== "f64" &&
          e.type.kind !== "string" &&
          e.type.kind !== "bool" &&
          e.type.kind !== "jsval" &&
          e.type.kind !== "union" &&
          e.type.kind !== "dyn"
        ) {
          err(`logical ${e.op} must be f64|string|bool|jsval|union|dyn, got ${e.type.kind}`, e.loc);
        }
        if (e.type.kind === "union") checkTruthyUnion(e.type.unionId, e.loc);
        expectType(e.left, e.type, `logical ${e.op} left`);
        expectType(e.right, e.type, `logical ${e.op} right`);
      } else if (e.kind === "nullish") {
        checkNullishOperands(e);
      } else if (e.kind === "ternary") {
        expectType(e.cond, BOOL, "ternary condition");
        expectType(e.then, e.type, "ternary then-branch");
        expectType(e.else_, e.type, "ternary else-branch");
        if (e.type.kind === "void") err("ternary must not be void", e.loc);
      }
    }
  }

  // Keep expression families in separate functions so native bootstrap builds
  // do not feed LLVM a single control-flow graph containing every IR check.
  /** fieldAbsent nodes that sit directly in a field-slot write (a
   * recordLit field, recordSet value, recordClone override, or a ternary
   * arm in one of those positions) — the only places the absent state may
   * appear. */
  const fieldSlotValues = new Set<IrExpr>();
  function checkSlotValue(e: IrExpr): void {
    const mark = (v: IrExpr): void => {
      if (v.kind === "fieldAbsent") fieldSlotValues.add(v);
      else if (v.kind === "ternary") {
        mark(v.then);
        mark(v.else_);
      }
    };
    mark(e);
    checkExpr(e);
  }

  function checkExpr(e: IrExpr): void {
    switch (e.kind) {
      case "numLit":
      case "strLit":
      case "moduleNsRef":
      case "boolLit":
      case "unitLit":
      case "varRef":
      case "bin":
      case "unary":
      case "incDec":
      case "fieldIncDec":
      case "assignExpr":
      case "seqExpr":
      case "dynDestrCheck":
      case "dynIterN":
      case "toBool":
      case "logical":
      case "nullish":
      case "ternary":
      case "unionEq":
      case "unionFuncEq":
        return checkScalarExpr(e);
      case "strConcat":
      case "strEq":
      case "strCmp":
      case "optChain":
      case "chainRecv":
      case "orDefault":
      case "toString":
      case "strIntrinsic":
      case "regexLit":
      case "templateStrings":
      case "regexIntrinsic":
        return checkStringExpr(e);
      case "arrayLit":
      case "arrayNewLen":
      case "arrayGet":
      case "arrayHas":
      case "arrayState":
      case "bytesNew":
      case "bytesIntrinsic":
      case "arrIntrinsic":
        return checkArrayExpr(e);
      case "mapNew":
      case "mapIntrinsic":
      case "setNew":
      case "setIntrinsic":
        return checkCollectionExpr(e);
      case "call":
      case "ffiCall":
      case "closure":
      case "callValue":
        return checkCallExpr(e);
      case "selfRef":
      case "new":
      case "fieldGet":
      case "promiseVoidWiden":
      case "upcast":
      case "downcast":
      case "classRef":
      case "newValue":
      case "instanceOfValue":
      case "instanceOf":
      case "virtualCall":
        return checkClassExpr(e);
      case "recordLit":
      case "recordClone":
      case "recordGet":
      case "recordKeyGet":
      case "recordOvfHas":
      case "recordOvfKeys":
      case "recordHas":
      case "fieldAbsent":
        return checkRecordExpr(e);
      case "dynFrom":
      case "dynFromJsval":
      case "dynCall":
      case "dynInvoke":
      case "dynObjLit":
      case "dynArrLit":
      case "unionWrap":
      case "dynTest":
      case "dynKeyGet":
      case "dynHasKey":
      case "dynScalarEq":
      case "caughtTest":
      case "caughtCheck":
      case "caughtToDyn":
      case "caughtNarrow":
        return checkDynamicExpr(e);
      case "unionNarrow":
      case "unionDisc":
      case "unionKeyGet":
      case "unionIsTag":
        return checkUnionExpr(e);
      case "intrinsic":
        return checkIntrinsicExpr(e);
      case "libCall":
        return checkLibCall(e);
      case "jsonStringify":
      case "dynCheck":
        return checkConversionExpr(e);
      case "awaitExpr":
      case "yieldExpr":
      case "genResume":
      case "awaitUnionExpr":
      case "newPromise":
      case "promiseWithResolvers":
        return checkAsyncExpr(e);
      case "jsMarshal":
      case "jsOp":
      case "jsExit":
      case "jsBridgePromise":
        return checkIslandExpr(e);
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkScalarExpr(
    e: IrExpr & {
      kind:
        | "numLit"
        | "strLit"
        | "moduleNsRef"
        | "boolLit"
        | "unitLit"
        | "varRef"
        | "bin"
        | "unary"
        | "incDec"
        | "fieldIncDec"
        | "assignExpr"
        | "seqExpr"
        | "dynDestrCheck"
        | "dynIterN"
        | "toBool"
        | "logical"
        | "nullish"
        | "ternary"
        | "unionEq"
        | "unionFuncEq";
    },
  ): void {
    switch (e.kind) {
      case "numLit":
        // ±Infinity and NaN are real literals (the globals
        // `Infinity`/`NaN`, Number constants) — the backend spells them
        // (bit-encoded f64 in LLVM).
        // procStream is the ONE non-f64 numLit: process.stdout/stderr as
        // first-class values mint the stream's fd (1/2) as the scalar —
        // the prefixStream idiom.
        if (
          e.type.kind !== "f64" &&
          !(e.type.kind === "procStream" && (e.value === 1 || e.value === 2))
        ) {
          err("numLit must be f64", e.loc);
        }
        break;
      case "strLit":
        if (e.type.kind !== "string") err("strLit must be string", e.loc);
        break;
      case "moduleNsRef":
        if (e.type.kind !== "moduleNs" || e.type.moduleId !== e.moduleId) {
          err("moduleNsRef must match its moduleNs type", e.loc);
        }
        break;
      case "boolLit":
        if (e.type.kind !== "bool") err("boolLit must be bool", e.loc);
        break;
      case "unitLit":
        // Reachable only for a unitLit OUTSIDE a unionWrap (the wrap case
        // validates its unit value inline) — unit types have no standalone
        // runtime value, so a bare one is frontend breakage.
        err(`bare unitLit '${e.unit}' outside a unionWrap`, e.loc);
        break;
      case "varRef": {
        const binding = locals.get(e.localId) ?? globals.get(e.localId);
        if (!binding) err(`varRef to undeclared local/global "${e.localId}"`, e.loc);
        else if (!typeEquals(binding.type, e.type)) {
          err(`varRef "${e.localId}" type ${e.type.kind} != binding ${binding.type.kind}`, e.loc);
        }
        break;
      }
      case "bin": {
        checkExpr(e.left);
        checkExpr(e.right);
        const isEq = e.op === "===" || e.op === "!==";
        if (isEq && e.left.type.kind === "func") {
          // Function identity tolerates DIFFERING static signatures (the
          // compare is pointer equality; tsc gates the overlap).
          if (e.right.type.kind !== "func") {
            err(`bin ${e.op} on functions: right operand is ${e.right.type.kind}`, e.loc);
          }
        } else if (isEq && e.left.type.kind === "classval") {
          // Class identity tolerates DIFFERING static classes like
          // function identity does signatures: one immortal object per
          // class, one pointer compare (tsc gates the overlap).
          if (e.right.type.kind !== "classval") {
            err(`bin ${e.op} on class values: right operand is ${e.right.type.kind}`, e.loc);
          }
        } else if (isEq && e.left.type.kind === "moduleNs") {
          if (e.right.type.kind !== "moduleNs") {
            err(`bin ${e.op} on module namespaces: right operand is ${e.right.type.kind}`, e.loc);
          }
        } else if (
          isEq &&
          (e.left.type.kind === "array" ||
            e.left.type.kind === "map" ||
            e.left.type.kind === "set" ||
            e.left.type.kind === "regex" ||
            e.left.type.kind === "url" ||
            e.left.type.kind === "object" ||
            e.left.type.kind === "record" ||
            // Symbol identity IS pointer identity (the frontend's rule).
            e.left.type.kind === "symbol" ||
            e.left.type.kind === "bytes" ||
            e.left.type.kind === "promise" ||
            // Runtime handles are objects to === (one handle per socket/
            // request — pointer identity is JS's object equality).
            DYN_HANDLE_KINDS.has(e.left.type.kind))
        ) {
          // Reference identity: both operands must be the same ref type.
          if (!typeEquals(e.left.type, e.right.type)) {
            err(`bin ${e.op} on references: operand types differ`, e.loc);
          }
        } else if (isEq && e.left.type.kind === "bool") {
          // bool === bool: a plain value compare.
          expectType(e.right, { kind: "bool" }, `bin ${e.op} right`);
        } else {
          expectType(e.left, { kind: "f64" }, `bin ${e.op} left`);
          expectType(e.right, { kind: "f64" }, `bin ${e.op} right`);
        }
        const isCompare = ["<", "<=", ">", ">=", "===", "!=="].includes(e.op);
        if (!typeEquals(e.type, isCompare ? BOOL : { kind: "f64" })) {
          err(`bin ${e.op} result must be ${isCompare ? "bool" : "f64"}`, e.loc);
        }
        break;
      }
      case "unary":
        checkExpr(e.operand);
        if (e.op === "-" || e.op === "~") {
          expectType(e.operand, { kind: "f64" }, `unary ${e.op}`);
          if (e.type.kind !== "f64") err(`unary ${e.op} must be f64`, e.loc);
        } else {
          expectType(e.operand, BOOL, "unary !");
          if (e.type.kind !== "bool") err("unary ! must be bool", e.loc);
        }
        break;
      case "incDec": {
        // Expression-position ++/--: an f64 local or module global,
        // mutable, read-and-written in place.
        const binding = locals.get(e.localId) ?? globals.get(e.localId);
        if (!binding) err(`incDec of undeclared local/global "${e.localId}"`, e.loc);
        else {
          if (!binding.mutable && locals.has(e.localId)) {
            err(`incDec of immutable local "${binding.name}"`, e.loc);
          }
          if (binding.type.kind !== "f64") {
            err(`incDec of non-f64 binding "${binding.name}" (${binding.type.kind})`, e.loc);
          }
        }
        if (e.type.kind !== "f64") err("incDec must be f64", e.loc);
        break;
      }
      case "fieldIncDec": {
        // Expression-position ++/-- over a class field: an f64 field, or a
        // dyn field with fieldDyn set (validated numeric read-modify-write).
        checkExpr(e.obj);
        const cls = classes.get(e.className);
        const fieldType = classValidation.fields.get(e.className)?.get(e.field);
        if (!cls) err(`fieldIncDec on undeclared class "${e.className}"`, e.loc);
        else if (!fieldType) err(`class ${e.className} has no field "${e.field}"`, e.loc);
        else {
          expectType(e.obj, { kind: "object", className: e.className }, "fieldIncDec receiver");
          if (e.fieldDyn ? fieldType.kind !== "dyn" : fieldType.kind !== "f64") {
            err(
              `fieldIncDec ${e.className}.${e.field} field/flag mismatch (${fieldType.kind})`,
              e.loc,
            );
          }
        }
        if (e.type.kind !== "f64") err("fieldIncDec must be f64", e.loc);
        break;
      }
      case "assignExpr": {
        // Expression-position `x = e`: a mutable local or module global,
        // written with a value of its own type; the expression yields it.
        checkExpr(e.value);
        const binding = locals.get(e.localId) ?? globals.get(e.localId);
        if (!binding) err(`assignExpr to undeclared local/global "${e.localId}"`, e.loc);
        else {
          if (!binding.mutable && locals.has(e.localId)) {
            err(`assignExpr to immutable local "${binding.name}"`, e.loc);
          }
          if (!typeEquals(binding.type, e.type)) {
            err(
              `assignExpr type must match binding "${binding.name}" (${binding.type.kind} vs ${e.type.kind})`,
              e.loc,
            );
          }
        }
        if (!typeEquals(e.value.type, e.type)) {
          err(`assignExpr value type must match its own type`, e.loc);
        }
        break;
      }
      case "seqExpr": {
        // Statements in an expression cannot jump out of the expression,
        // but a local state branch is valid: optional array stores must
        // choose ARRAY_VALUE versus ARRAY_UNDEFINED before the final result
        // is evaluated. Delegation also needs a local loop. Nested control
        // flow is checked recursively; jumps still cannot leave the region.
        const allowed = new Set([
          "varDecl",
          "assign",
          "exprStmt",
          "fieldSet",
          "recordSet",
          "recordKeySet",
          "arraySet",
          "arraySetLength",
          "arraySetUndefined",
          "arrayDelete",
          "bytesSet",
          "block",
          "if",
          "while",
        ]);
        if (e.generatorDelegate) {
          if (!fn.generator || fn.async)
            err("delegation sequence outside a synchronous generator", e.loc);
          allowed.add("return");
          allowed.add("throw");
          allowed.add("runtimeFence");
        }
        if (e.diverges) {
          const last = e.stmts[e.stmts.length - 1];
          if (last?.kind !== "runtimeFence")
            err("diverging seqExpr must end in a runtimeFence", e.loc);
          allowed.add("runtimeFence");
        }
        const flat = (ss: IrStmt[]): void => {
          for (const s of ss) {
            if (!allowed.has(s.kind)) {
              err(`seqExpr statement kind "${s.kind}" can leave the expression`, s.loc);
              continue;
            }
            if (s.kind === "block") {
              flat(s.body);
              continue;
            }
            if (s.kind === "if") {
              flat(s.then);
              if (s.else_) flat(s.else_);
              checkExpr(s.cond);
              continue;
            }
            if (s.kind === "while") {
              expectType(s.cond, BOOL, "seqExpr while condition");
              checkExpr(s.cond);
              flat(s.body);
              continue;
            }
            checkStmt(s);
          }
        };
        flat(e.stmts);
        checkExpr(e.result);
        if (!typeEquals(e.result.type, e.type)) err(`seqExpr type must match its result`, e.loc);
        break;
      }
      case "dynDestrCheck": {
        checkExpr(e.value);
        if (e.value.type.kind !== "dyn" && e.value.type.kind !== "jsval")
          err("dynDestrCheck value must be dyn or jsval", e.loc);
        if (e.type.kind !== e.value.type.kind)
          err("dynDestrCheck must have its value's type", e.loc);
        break;
      }
      case "dynIterN": {
        checkExpr(e.value);
        if (e.value.type.kind !== "dyn" && e.value.type.kind !== "jsval")
          err("dynIterN value must be dyn or jsval", e.loc);
        if (e.type.kind !== e.value.type.kind) err("dynIterN must have its value's type", e.loc);
        if (!Number.isInteger(e.count) || e.count < 0)
          err("dynIterN count must be a non-negative integer", e.loc);
        break;
      }
      case "toBool":
        checkExpr(e.operand);
        if (
          e.operand.type.kind !== "f64" &&
          e.operand.type.kind !== "string" &&
          e.operand.type.kind !== "dyn" &&
          e.operand.type.kind !== "union" &&
          !REF_TRUTHY_KINDS.has(e.operand.type.kind)
        ) {
          err(`toBool operand must be f64|string|dyn|union|ref, got ${e.operand.type.kind}`, e.loc);
        }
        if (e.operand.type.kind === "union") checkTruthyUnion(e.operand.type.unionId, e.loc);
        if (e.type.kind !== "bool") err("toBool must be bool", e.loc);
        break;
      case "logical":
      case "nullish":
      case "ternary":
        checkBranchingTree(e);
        break;
      case "unionEq": {
        checkExpr(e.left);
        checkExpr(e.right);
        if (!unions.has(e.unionId)) err(`unionEq of unknown union ${e.unionId}`, e.loc);
        const ut: IrType = { kind: "union", unionId: e.unionId };
        expectType(e.left, ut, "unionEq left");
        expectType(e.right, ut, "unionEq right");
        if (e.type.kind !== "bool") err("unionEq must be bool", e.loc);
        break;
      }
      case "unionFuncEq": {
        checkExpr(e.union);
        checkExpr(e.func);
        const def = unions.get(e.unionId);
        if (!def) err(`unionFuncEq of unknown union ${e.unionId}`, e.loc);
        expectType(e.union, { kind: "union", unionId: e.unionId }, "unionFuncEq union");
        const arm = def?.arms[e.tag];
        if (!Number.isInteger(e.tag) || arm?.kind !== "func") {
          err(`unionFuncEq tag ${e.tag} must select a function arm of ${e.unionId}`, e.loc);
        }
        if ((def?.arms.filter((candidate) => candidate.kind === "func").length ?? 0) !== 1) {
          err(`unionFuncEq requires exactly one function arm in ${e.unionId}`, e.loc);
        }
        if (e.func.type.kind !== "func") err("unionFuncEq function operand must be func", e.loc);
        if (e.type.kind !== "bool") err("unionFuncEq must be bool", e.loc);
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkStringExpr(
    e: IrExpr & {
      kind:
        | "strConcat"
        | "strEq"
        | "strCmp"
        | "optChain"
        | "chainRecv"
        | "orDefault"
        | "toString"
        | "strIntrinsic"
        | "regexLit"
        | "templateStrings"
        | "regexIntrinsic";
    },
  ): void {
    switch (e.kind) {
      case "strConcat":
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.left, STRING, "strConcat left");
        expectType(e.right, STRING, "strConcat right");
        if (e.type.kind !== "string") err("strConcat must be string", e.loc);
        break;
      case "strEq":
      case "strCmp":
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.left, STRING, `${e.kind} left`);
        expectType(e.right, STRING, `${e.kind} right`);
        if (e.type.kind !== "bool") err(`${e.kind} must be bool`, e.loc);
        break;
      case "optChain": {
        checkExpr(e.receiver);
        // An island-handle chain (`x?.y` on 'any'): the nullish test is a
        // runtime ask of the engine value; the body is the plain island
        // operation over the bound handle, and both body and result stay
        // jsval (the unit path is the engine's undefined).
        if (e.receiver.type.kind === "jsval") {
          if (activeChains.has(e.id)) err(`optChain id "${e.id}" shadows an active chain`, e.loc);
          activeChains.set(e.id, JSVAL);
          checkExpr(e.body);
          activeChains.delete(e.id);
          if (e.body.type.kind !== "jsval") {
            err(`jsval optChain with ${e.body.type.kind} body`, e.loc);
          }
          if (e.type.kind !== "jsval") {
            err(`jsval optChain must be jsval, got ${e.type.kind}`, e.loc);
          }
          break;
        }
        // A dyn (dyn) chain (`rawName?.match(re)` on a JSON.parse result):
        // the nullish test reads the node's kind tag; the body is the
        // validated dynamic dispatch, its result converted back into the
        // dyn (dynFrom) — so body and result are dyn, or void for
        // statement-position chains.
        if (e.receiver.type.kind === "dyn") {
          if (activeChains.has(e.id)) err(`optChain id "${e.id}" shadows an active chain`, e.loc);
          activeChains.set(e.id, DYN);
          checkExpr(e.body);
          activeChains.delete(e.id);
          if (e.body.type.kind !== "dyn" && e.body.type.kind !== "void") {
            err(`dyn optChain with ${e.body.type.kind} body`, e.loc);
          }
          if (e.type.kind !== "dyn" && e.type.kind !== "void") {
            err(`dyn optChain must be dyn or void, got ${e.type.kind}`, e.loc);
          }
          if (e.type.kind === "void" && e.body.type.kind !== "void") {
            err(`void dyn optChain with ${e.body.type.kind} body`, e.loc);
          }
          break;
        }
        if (e.receiver.type.kind !== "union") {
          err(`optChain receiver must be a union, got ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const def = unions.get(e.receiver.type.unionId);
        if (!def) {
          err(`optChain receiver references unknown union ${e.receiver.type.unionId}`, e.loc);
          break;
        }
        const rest = def.arms.filter((a) => !isUnitType(a));
        if (rest.length === 0 || rest.length === def.arms.length) {
          err("optChain receiver must have unit arms and at least one non-unit arm", e.loc);
          break;
        }
        if (activeChains.has(e.id)) err(`optChain id "${e.id}" shadows an active chain`, e.loc);
        activeChains.set(e.id, rest.length === 1 ? rest[0]! : e.receiver.type);
        checkExpr(e.body);
        activeChains.delete(e.id);
        if (e.type.kind === "void") {
          if (e.body.type.kind !== "void") {
            err(`void optChain with ${e.body.type.kind} body`, e.loc);
          }
          break;
        }
        expectType(e.body, e.type, "optChain body");
        // dyn results carry the unit path as the undefined dyn value; every
        // other value result needs an undefined arm to land on.
        if (e.type.kind !== "dyn") {
          const rdef = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          if (!rdef || !rdef.arms.some((a) => a.kind === "undefinedT")) {
            err("optChain type must be void, dyn, or an undefined-armed union", e.loc);
          }
        }
        break;
      }
      case "chainRecv": {
        const bound = activeChains.get(e.id);
        if (!bound) {
          err(`chainRecv "${e.id}" outside its optChain body`, e.loc);
          break;
        }
        expectType(e, bound, "chainRecv");
        break;
      }
      case "orDefault": {
        checkExpr(e.left);
        checkExpr(e.right);
        expectType(e.right, e.type, "orDefault right operand");
        if (e.left.type.kind !== "union") {
          err(`orDefault left must be a union, got ${e.left.type.kind}`, e.loc);
          break;
        }
        const def = unions.get(e.left.type.unionId);
        if (!def) {
          err(`orDefault left references unknown union ${e.left.type.unionId}`, e.loc);
          break;
        }
        // Retagged shape: the truthy side is a call to the named helper, so
        // the arm count is free and the type rule is the helper's signature.
        if (e.retag !== undefined) {
          const helper = functions.get(e.retag);
          if (!helper) {
            err(`orDefault retag calls undeclared function "${e.retag}"`, e.loc);
          } else if (
            helper.params.length !== 1 ||
            !typeEquals(helper.params[0]!.type, e.left.type)
          ) {
            err(`orDefault retag ${e.retag} must take exactly the left union`, e.loc);
          } else if (!typeEquals(callSiteReturnType(helper), e.type)) {
            err(`orDefault retag ${e.retag} must return the node's type`, e.loc);
          }
          break;
        }
        const rest = def.arms.filter((a) => !isUnitType(a));
        if (rest.length !== 1 || !typeEquals(e.type, rest[0]!)) {
          err("orDefault type must be the left union's single non-unit arm", e.loc);
        }
        break;
      }
      case "toString":
        checkExpr(e.operand);
        if (e.operand.type.kind === "union") {
          // Union operands dispatch through the per-union ToString helper;
          // every arm needs a text (unit/string/f64/bool, plus the Buffer
          // arm whose toString IS the utf8 decode — the frontend fences
          // unions with other ref arms, where JS prints "[object Object]").
          const def = unions.get(e.operand.type.unionId);
          if (!def) {
            err(`toString of unknown union ${e.operand.type.unionId}`, e.loc);
          } else if (
            !def.arms.every(
              (a) =>
                a.kind === "undefinedT" ||
                a.kind === "nullT" ||
                a.kind === "string" ||
                a.kind === "f64" ||
                a.kind === "bigint" ||
                a.kind === "bool" ||
                (a.kind === "bytes" && a.elem === "u8"),
            )
          ) {
            err("toString union operand has a non-stringable arm (frontend must fence)", e.loc);
          }
        } else if (
          e.operand.type.kind !== "f64" &&
          e.operand.type.kind !== "bool" &&
          e.operand.type.kind !== "caught" &&
          e.operand.type.kind !== "dyn" &&
          // Plain data records print Object.prototype.toString's constant
          // (tuples and toString-field shapes are fenced in the frontend).
          e.operand.type.kind !== "record"
        ) {
          err(
            `toString operand must be f64|bool|caught|dyn|record, got ${e.operand.type.kind}`,
            e.loc,
          );
        }
        if (e.type.kind !== "string") err("toString must be string", e.loc);
        break;
      case "strIntrinsic": {
        checkExpr(e.receiver);
        expectType(e.receiver, STRING, `strIntrinsic ${e.method} receiver`);
        const sig = STR_INTRINSIC_SIGS[e.method];
        if (e.args.length < sig.minArgs || e.args.length > sig.argTypes.length) {
          const want =
            sig.minArgs === sig.argTypes.length
              ? `${sig.argTypes.length}`
              : `${sig.minArgs}-${sig.argTypes.length}`;
          err(`strIntrinsic ${e.method}: ${e.args.length} args, expected ${want}`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `strIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`strIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "regexLit": {
        if (e.type.kind !== "regex") err("regexLit must be regex-typed", e.loc);
        if (!/^[gimsuy]*$/.test(e.flags)) {
          err(`regexLit flags "${e.flags}" outside the supported alphabet (gimsuy)`, e.loc);
        }
        if (new Set(e.flags).size !== e.flags.length) {
          err(`regexLit flags "${e.flags}" contain a duplicate`, e.loc);
        }
        break;
      }
      case "templateStrings": {
        if (e.type.kind !== "array" || e.type.elem.kind !== "string") {
          err("templateStrings must be string[]-typed", e.loc);
        }
        if (e.key === "") err("templateStrings key must be non-empty", e.loc);
        break;
      }
      case "regexIntrinsic": {
        checkExpr(e.receiver);
        const sig = REGEX_INTRINSIC_SIGS[e.method];
        expectType(e.receiver, sig.receiver, `regexIntrinsic ${e.method} receiver`);
        if (e.args.length !== sig.argTypes.length) {
          err(
            `regexIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`,
            e.loc,
          );
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `regexIntrinsic ${e.method} arg ${i}`);
        });
        if (e.method === "match" || e.method === "exec") {
          // The `string[] | null` union (program-dependent id) — checked
          // by arms, like the libCall case checks process.envGet.
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const ok =
            def &&
            def.arms.length === 2 &&
            def.arms.some((a) => a.kind === "array" && a.elem.kind === "string") &&
            def.arms.some((a) => a.kind === "nullT");
          if (!ok) err("regexIntrinsic match must be the string[] | null union", e.loc);
          break;
        }
        if (!typeEquals(e.type, sig.result)) {
          err(`regexIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkArrayExpr(
    e: IrExpr & {
      kind:
        | "arrayLit"
        | "arrayNewLen"
        | "arrayGet"
        | "arrayHas"
        | "arrayState"
        | "bytesNew"
        | "bytesIntrinsic"
        | "arrIntrinsic";
    },
  ): void {
    switch (e.kind) {
      case "arrayLit": {
        if (e.type.kind !== "array") {
          err(`arrayLit must be array-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        const elem = e.type.elem;
        if (!isSupportedArrayElem(elem)) {
          err(`arrayLit with unsupported ${elem.kind} elements (frontend must fence)`, e.loc);
        }
        const spreadSet = new Set(e.spreads ?? []);
        for (const i of spreadSet) {
          if (!Number.isInteger(i) || i < 0 || i >= e.elems.length) {
            err(`arrayLit spread index ${i} out of range`, e.loc);
          }
        }
        e.elems.forEach((el, i) => {
          checkExpr(el);
          // Spread positions hold a same-typed ARRAY (copied element-wise);
          // plain positions hold one element.
          expectType(el, spreadSet.has(i) ? e.type : elem, `arrayLit element ${i}`);
        });
        break;
      }
      case "arrayNewLen": {
        // Mapper-less Array.from({length: n}): absent-slot fill exists
        // only for refcounted element kinds (frontend fences scalars).
        if (e.type.kind !== "array") {
          err(`arrayNewLen must be array-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        if (!isRefCounted(e.type.elem)) {
          err(
            `arrayNewLen with non-refcounted ${e.type.elem.kind} elements (no absent value)`,
            e.loc,
          );
        }
        if (!isSupportedArrayElem(e.type.elem)) {
          err(
            `arrayNewLen with unsupported ${e.type.elem.kind} elements (frontend must fence)`,
            e.loc,
          );
        }
        checkExpr(e.length);
        expectType(e.length, F64, "arrayNewLen length");
        break;
      }
      case "arrayGet": {
        checkExpr(e.arr);
        checkExpr(e.index);
        expectType(e.index, F64, "arrayGet index");
        if (e.arr.type.kind !== "array") {
          err(`arrayGet on non-array ${e.arr.type.kind}`, e.loc);
        } else if (!typeEquals(e.type, e.arr.type.elem)) {
          err(`arrayGet result ${e.type.kind} != element ${e.arr.type.elem.kind}`, e.loc);
        }
        break;
      }
      case "arrayHas": {
        checkExpr(e.arr);
        checkExpr(e.index);
        expectType(e.index, F64, "arrayHas index");
        if (!typeEquals(e.type, BOOL)) err(`arrayHas result ${e.type.kind} != bool`, e.loc);
        if (e.arr.type.kind !== "array") {
          err(`arrayHas on non-array ${e.arr.type.kind}`, e.loc);
        }
        break;
      }
      case "arrayState": {
        checkExpr(e.arr);
        checkExpr(e.index);
        expectType(e.index, F64, "arrayState index");
        if (!typeEquals(e.type, F64)) err(`arrayState result ${e.type.kind} != f64`, e.loc);
        if (e.arr.type.kind !== "array") err(`arrayState on non-array ${e.arr.type.kind}`, e.loc);
        break;
      }
      case "bytesNew": {
        if (e.type.kind !== "bytes") {
          err(`bytesNew of non-bytes type ${e.type.kind}`, e.loc);
          break;
        }
        if (e.source) {
          checkExpr(e.source);
          const sk = e.source.type;
          if (sk.kind === "array") {
            if (sk.elem.kind !== "f64") {
              err(`bytesNew array source must hold f64, got ${sk.elem.kind}`, e.loc);
            }
          } else if (sk.kind !== "f64" && sk.kind !== "bytes" && sk.kind !== "dyn") {
            err(`bytesNew source of kind ${sk.kind}`, e.loc);
          }
        }
        if (e.from && e.source?.type.kind !== "dyn")
          err("bytesNew from requires a dyn source", e.loc);
        break;
      }
      case "bytesIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "bytes") {
          err(`bytesIntrinsic ${e.method} on non-bytes ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const recv = e.receiver.type;
        // The DataView getters and setters use a bytes<u8>
        // view; dataViewNew and byteOffset take ANY elem kind (views form
        // over any typed array's storage, owners answer byteOffset 0).
        const isDv = e.method.startsWith("dvGet") || e.method.startsWith("dvSet");
        const isNum =
          e.method === "readNum" ||
          e.method === "writeNum" ||
          e.method === "readNumVar" ||
          e.method === "writeNumVar";
        const U8_ONLY_EXTRA: ReadonlySet<string> = new Set([
          "toString",
          "toStringVar",
          "equals",
          "compareBuf",
          "indexOf",
          "lastIndexOf",
          "includes",
          "indexOfNum",
          "lastIndexOfNum",
          "includesNum",
          "fill",
          "fillNum",
          "fillStr",
          "copy",
          "swap16",
          "swap32",
          "swap64",
          "writeStr",
        ]);
        const u8Only = U8_ONLY_EXTRA.has(e.method) || isNum || isDv;
        if (u8Only && recv.elem !== "u8") {
          err(`bytesIntrinsic ${e.method} on a ${recv.elem} receiver (u8 only)`, e.loc);
        }
        // The numeric families' kind rides as args[0] — ALWAYS a string
        // literal (the backend maps it to the runtime tag at compile
        // time; a runtime-valued kind has no meaning).
        if (isNum && e.args[0]?.kind !== "strLit") {
          err(`bytesIntrinsic ${e.method} args[0] must be a strLit kind token`, e.loc);
        } else if (
          isNum &&
          e.args[0]?.kind === "strLit" &&
          !validByteNumberToken(e.method, e.args[0].value)
        ) {
          err(`bytesIntrinsic ${e.method} invalid kind token '${e.args[0].value}'`, e.loc);
        }
        // fillStr/writeStr carry their NORMALIZED encoding as args[1],
        // always a strLit (the frontend folds the aliases).
        if ((e.method === "fillStr" || e.method === "writeStr") && e.args[1]?.kind !== "strLit") {
          err(`bytesIntrinsic ${e.method} args[1] must be a strLit encoding`, e.loc);
        }
        const EXTRA_SIGS: Record<
          string,
          { argTypes: IrType[]; minArgs: number; result: IrType } | undefined
        > = {
          buffer: { argTypes: [], minArgs: 0, result: DYN },
          setFromDyn: { argTypes: [DYN, F64], minArgs: 1, result: VOID },
          copyWithin: { argTypes: [F64, F64, F64], minArgs: 3, result: bytesOf(recv.elem) },
          equals: { argTypes: [BYTES_U8], minArgs: 1, result: BOOL },
          compareBuf: { argTypes: [BYTES_U8, F64, F64, F64, F64], minArgs: 1, result: F64 },
          // [needle, align, byteOffset?] — an OMITTED byteOffset is Node's
          // search-everything default (the backend passes NaN).
          indexOf: { argTypes: [BYTES_U8, F64, F64], minArgs: 2, result: F64 },
          lastIndexOf: { argTypes: [BYTES_U8, F64, F64], minArgs: 2, result: F64 },
          includes: { argTypes: [BYTES_U8, F64, F64], minArgs: 2, result: BOOL },
          indexOfNum: { argTypes: [F64, F64], minArgs: 1, result: F64 },
          lastIndexOfNum: { argTypes: [F64, F64], minArgs: 1, result: F64 },
          includesNum: { argTypes: [F64, F64], minArgs: 1, result: BOOL },
          fill: { argTypes: [BYTES_U8, F64, F64], minArgs: 1, result: BYTES_U8 },
          fillNum: { argTypes: [F64, F64, F64], minArgs: 1, result: BYTES_U8 },
          // Per-element TypedArray fill (any elem — the non-u8 fill path).
          fillElem: { argTypes: [F64, F64, F64], minArgs: 1, result: bytesOf(recv.elem) },
          fillStr: { argTypes: [STRING, STRING, F64, F64], minArgs: 2, result: BYTES_U8 },
          copy: { argTypes: [BYTES_U8, F64, F64, F64], minArgs: 1, result: F64 },
          swap16: { argTypes: [], minArgs: 0, result: BYTES_U8 },
          swap32: { argTypes: [], minArgs: 0, result: BYTES_U8 },
          swap64: { argTypes: [], minArgs: 0, result: BYTES_U8 },
          writeStr: { argTypes: [STRING, STRING, F64, F64], minArgs: 3, result: F64 },
        };
        // Object.hasOwn: "toString" is a real method name here and must
        // not answer from Object.prototype.
        const extraSig = Object.hasOwn(EXTRA_SIGS, e.method) ? EXTRA_SIGS[e.method] : undefined;
        const sig: { argTypes: IrType[]; minArgs: number; result: IrType } =
          extraSig ??
          (e.method === "length" || e.method === "byteLength" || e.method === "byteOffset"
            ? { argTypes: [], minArgs: 0, result: F64 }
            : e.method === "get"
              ? { argTypes: [F64], minArgs: 1, result: F64 }
              : e.method === "slice" || e.method === "subarray"
                ? { argTypes: [F64, F64], minArgs: 0, result: bytesOf(recv.elem) }
                : e.method === "toReversed"
                  ? { argTypes: [], minArgs: 0, result: bytesOf(recv.elem) }
                  : e.method === "with"
                    ? { argTypes: [F64, F64], minArgs: 2, result: bytesOf(recv.elem) }
                    : e.method === "join"
                      ? { argTypes: [STRING], minArgs: 1, result: STRING }
                      : e.method === "toArray"
                        ? { argTypes: [], minArgs: 0, result: arrayOf(F64) }
                        : e.method === "setFrom"
                          ? {
                              argTypes: [
                                e.args[0]?.type.kind === "bytes"
                                  ? e.args[0].type
                                  : bytesOf(recv.elem),
                                F64,
                              ],
                              minArgs: 1,
                              result: VOID,
                            }
                          : e.method === "toString" || e.method === "toStringVar"
                            ? { argTypes: [STRING, F64, F64], minArgs: 1, result: STRING }
                            : e.method === "readNum"
                              ? { argTypes: [STRING, F64], minArgs: 2, result: F64 }
                              : e.method === "writeNum"
                                ? { argTypes: [STRING, F64, F64], minArgs: 3, result: F64 }
                                : e.method === "readNumVar"
                                  ? { argTypes: [STRING, F64, F64], minArgs: 3, result: F64 }
                                  : e.method === "writeNumVar"
                                    ? { argTypes: [STRING, F64, F64, F64], minArgs: 4, result: F64 }
                                    : e.method === "dataViewNew"
                                      ? { argTypes: [F64, F64], minArgs: 0, result: BYTES_U8 }
                                      : e.method.startsWith("dvSet")
                                        ? {
                                            // dvSet*: [offset, value], the 8-bit setters take no littleEndian.
                                            argTypes:
                                              e.method === "dvSetUint8" || e.method === "dvSetInt8"
                                                ? [F64, F64]
                                                : [F64, F64, BOOL],
                                            minArgs: 2,
                                            result: VOID,
                                          }
                                        : {
                                            // dvGet*: the 8-bit getters take no littleEndian.
                                            argTypes:
                                              e.method === "dvGetUint8" || e.method === "dvGetInt8"
                                                ? [F64]
                                                : [F64, BOOL],
                                            minArgs: 1,
                                            result: F64,
                                          });
        if (e.args.length < sig.minArgs || e.args.length > sig.argTypes.length) {
          err(`bytesIntrinsic ${e.method}: ${e.args.length} args`, e.loc);
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `bytesIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(
            `bytesIntrinsic ${e.method} result must be ${sig.result.kind}, got ${e.type.kind}`,
            e.loc,
          );
        }
        break;
      }
      case "arrIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "array") {
          err(`arrIntrinsic ${e.method} on non-array ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const elem = e.receiver.type.elem;
        const sig =
          e.method === "copyWithin"
            ? { argTypes: [F64, F64, F64], result: e.receiver.type }
            : e.method === "fill"
              ? { argTypes: [elem, F64, F64], result: e.receiver.type }
              : e.method === "fillUndefined"
                ? { argTypes: [F64, F64], result: e.receiver.type }
                : e.method === "push" || e.method === "unshift"
                  ? { argTypes: e.args.map(() => elem), result: F64 }
                  : e.method === "pushSpread" ||
                      e.method === "concatSpread" ||
                      e.method === "unshiftSpread"
                    ? { argTypes: [e.receiver.type], result: F64 }
                    : e.method === "nextPresent" || e.method === "getNumber"
                      ? { argTypes: [F64], result: F64 }
                      : e.method === "indexEq"
                        ? { argTypes: [F64, e.receiver.type, F64], result: BOOL }
                        : e.method === "pop"
                          ? { argTypes: [], result: e.type } // union-checked below
                          : e.method === "indexOf"
                            ? { argTypes: [elem], result: F64 }
                            : e.method === "includes"
                              ? { argTypes: [elem], result: BOOL }
                              : e.method === "join"
                                ? { argTypes: [STRING], result: STRING }
                                : e.method === "slice"
                                  ? { argTypes: [F64, F64], result: e.receiver.type }
                                  : e.method === "toReversed" ||
                                      e.method === "sortPrimitive" ||
                                      e.method === "toSortedPrimitive"
                                    ? { argTypes: [], result: e.receiver.type }
                                    : e.method === "reverse"
                                      ? { argTypes: [], result: e.receiver.type }
                                      : e.method === "toSpliced"
                                        ? {
                                            argTypes: [F64, F64, e.receiver.type],
                                            result: e.receiver.type,
                                          }
                                        : e.method === "with"
                                          ? { argTypes: [F64, elem], result: e.receiver.type }
                                          : e.method === "withUndefined"
                                            ? { argTypes: [F64], result: e.receiver.type }
                                            : e.method === "splice"
                                              ? { argTypes: [F64, F64], result: e.receiver.type }
                                              : e.method === "spliceInsert"
                                                ? {
                                                    argTypes: [F64, F64, e.receiver.type],
                                                    result: e.receiver.type,
                                                  }
                                                : e.method === "flatCopy" || e.method === "flatOne"
                                                  ? { argTypes: [e.type], result: e.type }
                                                  : e.method === "shift"
                                                    ? { argTypes: [], result: e.type } // union-checked below
                                                    : { argTypes: [], result: F64 }; // length
        if (
          (e.method === "sortPrimitive" || e.method === "toSortedPrimitive") &&
          elem.kind !== "string" &&
          elem.kind !== "f64" &&
          elem.kind !== "bool"
        ) {
          err(`arrIntrinsic ${e.method} requires primitive elements, got ${elem.kind}`, e.loc);
        }
        if (e.method === "getNumber" && elem.kind !== "f64") {
          err(`arrIntrinsic getNumber requires f64 elements, got ${elem.kind}`, e.loc);
        }
        if (
          e.method === "indexEq" &&
          elem.kind !== "f64" &&
          elem.kind !== "bool" &&
          elem.kind !== "string"
        ) {
          err(`arrIntrinsic indexEq requires primitive elements, got ${elem.kind}`, e.loc);
        }
        if (e.method === "flatCopy" && !typeEquals(e.type, e.receiver.type)) {
          err("arrIntrinsic flatCopy result must match its receiver", e.loc);
        }
        if (e.method === "flatOne" && (elem.kind !== "array" || !typeEquals(e.type, elem))) {
          err("arrIntrinsic flatOne result must match the nested array type", e.loc);
        }
        if (
          e.method === "join" &&
          elem.kind !== "f64" &&
          elem.kind !== "string" &&
          elem.kind !== "bool" &&
          !(
            elem.kind === "union" &&
            (unions
              .get(elem.unionId)
              ?.arms.every(
                (a) =>
                  a.kind === "f64" || a.kind === "string" || a.kind === "bool" || isUnitType(a),
              ) ??
              false)
          )
        ) {
          err(`arrIntrinsic join on ${elem.kind} elements (frontend must reject)`, e.loc);
        }
        if ((e.method === "indexOf" || e.method === "includes") && elem.kind === "union") {
          // Union boxes are compiler artifacts — pointer identity would
          // misjudge JS ===; the frontend fences these.
          err(`arrIntrinsic ${e.method} on union elements (frontend must reject)`, e.loc);
        }
        if (
          (e.method === "shift" || e.method === "pop") &&
          !(elem.kind === "dyn" && e.type.kind === "dyn")
        ) {
          const rdef = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          if (
            !rdef ||
            !rdef.arms.some((arm) => arm.kind === "undefinedT") ||
            !(elem.kind === "union"
              ? typeEquals(elem, e.type)
              : rdef.arms.some((arm) => typeEquals(arm, elem)))
          ) {
            err(`arrIntrinsic ${e.method} result must be the elem|undefined union`, e.loc);
          }
        }
        // slice's indices and splice's count are optional (omitted args
        // omitted from the IR — backends fill the defaults); everything
        // else is exact.
        const minArgs = e.method === "slice" ? 0 : e.method === "splice" ? 1 : sig.argTypes.length;
        if (e.args.length < minArgs || e.args.length > sig.argTypes.length) {
          err(
            `arrIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`,
            e.loc,
          );
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `arrIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`arrIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkCollectionExpr(
    e: IrExpr & { kind: "mapNew" | "mapIntrinsic" | "setNew" | "setIntrinsic" },
  ): void {
    switch (e.kind) {
      case "mapNew": {
        if (e.type.kind !== "map") {
          err(`mapNew must be map-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        if (
          !isSupportedMapKey(
            e.type.key,
            e.type.key.kind === "union" ? unions.get(e.type.key.unionId)?.arms : undefined,
          )
        ) {
          err(`mapNew key kind ${e.type.key.kind} (frontend must fence)`, e.loc);
        }
        if (!isSupportedMapValue(e.type.value)) {
          err(`mapNew value kind ${e.type.value.kind} (frontend must fence)`, e.loc);
        }
        // Seed entries lower pairwise, K/V-typed exactly like set() args.
        for (const pair of e.seed ?? []) {
          checkExpr(pair.key);
          expectType(pair.key, e.type.key, "mapNew seed key");
          checkExpr(pair.value);
          expectType(pair.value, e.type.value, "mapNew seed value");
        }
        break;
      }
      case "mapIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "map") {
          err(`mapIntrinsic ${e.method} on non-map ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const { key, value } = e.receiver.type;
        if (e.method === "get") {
          // Result is the interned `V | undefined` union: an undefined arm
          // must exist, and every OTHER arm must be V (V non-union) or one
          // of V's arms IN ORDER (V union — `undefined` sorts last in
          // canonical arm order, so tags coincide and the backend can hand
          // the stored box straight through).
          if (e.args.length !== 1) {
            err(`mapIntrinsic get: ${e.args.length} args, expected 1`, e.loc);
            break;
          }
          checkExpr(e.args[0]!);
          expectType(e.args[0]!, key, "mapIntrinsic get key");
          if (value.kind === "dyn") {
            expectType(e, DYN, "mapIntrinsic get result");
            break;
          }
          const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
          const rest = def ? def.arms.filter((a): boolean => a.kind !== "undefinedT") : [];
          // When V is itself a union its own undefined arm (if any) folds
          // into the result's — compare the non-undefined arms pairwise.
          const varms: IrType[] =
            value.kind === "union"
              ? (unions.get(value.unionId)?.arms ?? []).filter(
                  (a): boolean => a.kind !== "undefinedT",
                )
              : [value];
          const ok =
            def &&
            rest.length === def.arms.length - 1 &&
            def.arms[def.arms.length - 1]!.kind === "undefinedT" &&
            rest.length === varms.length &&
            rest.every((a, i) => typeEquals(a, varms[i]!));
          if (!ok) {
            err(`mapIntrinsic get must return the 'V | undefined' union`, e.loc);
          }
          break;
        }
        if (
          e.method === "valueSet" &&
          !isSupportedSetElem(
            value,
            value.kind === "union" ? unions.get(value.unionId)?.arms : undefined,
          )
        ) {
          err(`mapIntrinsic valueSet element kind ${value.kind} (frontend must fence)`, e.loc);
        }
        const sig =
          e.method === "clone"
            ? { argTypes: [], result: e.receiver.type }
            : e.method === "keySet" || e.method === "valueSet"
              ? {
                  argTypes: [],
                  result: { kind: "set", elem: e.method === "keySet" ? key : value } as IrType,
                }
              : e.method === "set"
                ? { argTypes: [key, value], result: VOID }
                : e.method === "has" || e.method === "delete"
                  ? { argTypes: [key], result: BOOL }
                  : e.method === "clear" || e.method === "iterEnter" || e.method === "iterExit"
                    ? { argTypes: [], result: VOID }
                    : e.method === "iterLive"
                      ? { argTypes: [F64], result: BOOL }
                      : e.method === "iterKey"
                        ? { argTypes: [F64], result: key }
                        : e.method === "iterValue"
                          ? { argTypes: [F64], result: value }
                          : { argTypes: [], result: F64 }; // size / iterCount
        if (e.args.length !== sig.argTypes.length) {
          err(
            `mapIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`,
            e.loc,
          );
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `mapIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`mapIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "setNew": {
        if (e.type.kind !== "set") {
          err(`setNew must be set-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        if (
          !isSupportedSetElem(
            e.type.elem,
            e.type.elem.kind === "union" ? unions.get(e.type.elem.unionId)?.arms : undefined,
          )
        ) {
          err(`setNew element kind ${e.type.elem.kind} (frontend must fence)`, e.loc);
        }
        // The seed is one T[]-typed expression (T = the element type).
        if (e.seed) {
          checkExpr(e.seed);
          expectType(e.seed, arrayOf(e.type.elem), "setNew seed");
        }
        break;
      }
      case "setIntrinsic": {
        checkExpr(e.receiver);
        if (e.receiver.type.kind !== "set") {
          err(`setIntrinsic ${e.method} on non-set ${e.receiver.type.kind}`, e.loc);
          break;
        }
        const { elem } = e.receiver.type;
        const sig =
          e.method === "clone"
            ? { argTypes: [], result: e.receiver.type }
            : e.method === "add"
              ? { argTypes: [elem], result: VOID }
              : e.method === "has" || e.method === "delete"
                ? { argTypes: [elem], result: BOOL }
                : e.method === "clear" || e.method === "iterEnter" || e.method === "iterExit"
                  ? { argTypes: [], result: VOID }
                  : e.method === "iterLive"
                    ? { argTypes: [F64], result: BOOL }
                    : e.method === "iterKey"
                      ? { argTypes: [F64], result: elem }
                      : e.method === "toArray"
                        ? { argTypes: [], result: arrayOf(elem) }
                        : { argTypes: [], result: F64 }; // size / iterCount
        if (e.args.length !== sig.argTypes.length) {
          err(
            `setIntrinsic ${e.method}: ${e.args.length} args, expected ${sig.argTypes.length}`,
            e.loc,
          );
        }
        e.args.forEach((a, i) => {
          checkExpr(a);
          const want = sig.argTypes[i];
          if (want) expectType(a, want, `setIntrinsic ${e.method} arg ${i}`);
        });
        if (!typeEquals(e.type, sig.result)) {
          err(`setIntrinsic ${e.method} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkCallExpr(e: IrExpr & { kind: "call" | "ffiCall" | "closure" | "callValue" }): void {
    switch (e.kind) {
      case "call": {
        for (const a of e.args) checkExpr(a);
        const callee = functions.get(e.callee);
        if (!callee) {
          err(`call to undeclared function "${e.callee}"`, e.loc);
          break;
        }
        if (callee.params.length !== e.args.length) {
          err(`call ${e.callee}: ${e.args.length} args, expected ${callee.params.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          const p = callee.params[i];
          if (p) expectType(a, p.type, `call ${e.callee} arg ${i}`);
        });
        const expected = callSiteReturnType(callee);
        if (!typeEquals(e.type, expected)) {
          err(`call ${e.callee} type ${e.type.kind} != return ${expected.kind}`, e.loc);
        }
        break;
      }
      case "ffiCall": {
        for (const arg of e.args) checkExpr(arg);
        const entry = ffiByName.get(e.import);
        if (!entry) {
          err(`FFI call to undeclared import "${e.import}"`, e.loc);
          break;
        }
        const sourceParamTypes = ffiSourceParamTypes(entry.params);
        if (sourceParamTypes.length !== e.args.length) {
          err(
            `FFI call ${e.import}: ${e.args.length} args, expected ${sourceParamTypes.length}`,
            e.loc,
          );
        }
        e.args.forEach((arg, i) => {
          const expectedParam = sourceParamTypes[i];
          if (expectedParam !== undefined) {
            expectType(arg, expectedParam, `FFI call ${e.import} arg ${i}`);
          }
        });
        const expected = ffiClassType(entry.returns);
        if (!typeEquals(e.type, expected)) {
          err(`FFI call ${e.import} type ${e.type.kind} != return class ${entry.returns}`, e.loc);
        }
        break;
      }
      case "closure": {
        const target = functions.get(e.fnName);
        if (!target) {
          err(`closure over undeclared function "${e.fnName}"`, e.loc);
          break;
        }
        if (e.type.kind !== "func") {
          err("closure must have func type", e.loc);
          break;
        }
        const wantCaps = target.captures ?? [];
        if (e.adapts === true && locals.get(e.captures[0] ?? "")?.type.kind !== "func") {
          err(`closure ${e.fnName}: an adapter's first capture must be a function`, e.loc);
        }
        if (target.captures === undefined && e.captures.length > 0) {
          err(`closure over plain function "${e.fnName}" cannot capture`, e.loc);
        }
        if (e.captures.length !== wantCaps.length) {
          err(
            `closure ${e.fnName}: ${e.captures.length} captures, expected ${wantCaps.length}`,
            e.loc,
          );
        }
        e.captures.forEach((id, i) => {
          const local = locals.get(id);
          const want = wantCaps[i];
          if (!local) err(`closure capture of undeclared local "${id}"`, e.loc);
          else if (!local.boxed) err(`closure capture "${id}" is not boxed`, e.loc);
          else if (want && !typeEquals(local.type, want.type)) {
            err(`closure capture "${id}" type ${local.type.kind} != ${want.type.kind}`, e.loc);
          }
        });
        // Result func type must match the target's signature. A VARIADIC
        // (rest-marked) type hides one synthetic trailing dyn-array param
        // in the lifted function (the thunk fills it) — the type's
        // declared params plus that one must match.
        if (e.type.kind === "func") {
          const wantRet = callSiteReturnType(target);
          // ISLAND-REST types (restAbi jsval) SPELL their trailing engine
          // array param — the lifted signature matches directly, no
          // hidden slot.
          const hiddenRest = e.type.rest === true && e.type.restAbi === undefined;
          const declared = hiddenRest ? target.params.slice(0, -1) : target.params;
          const restOk =
            !hiddenRest ||
            (target.params.length === e.type.params.length + 1 &&
              target.params[target.params.length - 1]!.type.kind === "dyn");
          if (
            !restOk ||
            e.type.params.length !== declared.length ||
            !e.type.params.every((p, i) => typeEquals(p, declared[i]!.type)) ||
            !typeEquals(e.type.ret, wantRet)
          ) {
            err(`closure ${e.fnName}: func type does not match target signature`, e.loc);
          }
        }
        break;
      }
      case "callValue": {
        checkExpr(e.callee);
        if (e.receiver !== undefined) {
          checkExpr(e.receiver);
          expectType(e.receiver, DYN, "callValue receiver");
        }
        for (const a of e.args) checkExpr(a);
        if (e.callee.type.kind !== "func") {
          err(`callValue callee is ${e.callee.type.kind}, not func`, e.loc);
          break;
        }
        const ft = e.callee.type;
        if (ft.params.length !== e.args.length) {
          err(`callValue: ${e.args.length} args, expected ${ft.params.length}`, e.loc);
        }
        e.args.forEach((a, i) => {
          const p = ft.params[i];
          if (p) expectType(a, p, `callValue arg ${i}`);
        });
        if (!typeEquals(e.type, ft.ret)) {
          err(`callValue type ${e.type.kind} != return ${ft.ret.kind}`, e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkClassExpr(
    e: IrExpr & {
      kind:
        | "selfRef"
        | "new"
        | "fieldGet"
        | "promiseVoidWiden"
        | "upcast"
        | "downcast"
        | "classRef"
        | "newValue"
        | "instanceOfValue"
        | "instanceOf"
        | "virtualCall";
    },
  ): void {
    switch (e.kind) {
      case "selfRef":
        if (fn.captures === undefined) {
          err("selfRef outside a lifted function", e.loc);
        }
        if (e.type.kind !== "func") err("selfRef must have func type", e.loc);
        break;
      case "new": {
        for (const a of e.args) checkExpr(a);
        const cls = classes.get(e.className);
        if (!cls) {
          err(`new of undeclared class "${e.className}"`, e.loc);
          break;
        }
        const ctor = functions.get(`%${e.className}.constructor`);
        if (cls.localCaptures !== undefined)
          err(`new ${e.className}: local class requires a class value`, e.loc);
        if (!ctor) {
          err(`new ${e.className}: missing constructor function`, e.loc);
          break;
        }
        // arg 0 is `this` (supplied by the new expr itself)
        if (ctor.params.length !== e.args.length + 1) {
          err(
            `new ${e.className}: ${e.args.length} args, ctor expects ${ctor.params.length - 1}`,
            e.loc,
          );
        }
        e.args.forEach((a, i) => {
          const p = ctor.params[i + 1];
          if (p) expectType(a, p.type, `new ${e.className} arg ${i}`);
        });
        if (!typeEquals(e.type, { kind: "object", className: e.className })) {
          err(`new ${e.className} must have that object type`, e.loc);
        }
        break;
      }
      case "fieldGet": {
        checkExpr(e.obj);
        const cls = classes.get(e.className);
        const fieldType = classValidation.fields.get(e.className)?.get(e.field);
        if (!cls) err(`fieldGet on undeclared class "${e.className}"`, e.loc);
        else if (!fieldType) err(`class ${e.className} has no field "${e.field}"`, e.loc);
        else {
          expectType(e.obj, { kind: "object", className: e.className }, "fieldGet receiver");
          if (!typeEquals(e.type, fieldType)) {
            err(`fieldGet ${e.className}.${e.field} type mismatch`, e.loc);
          }
        }
        break;
      }
      case "promiseVoidWiden": {
        // A promise value flowing into a VOID-promise slot: one C
        // representation, type-only — sound for every inner (awaiting
        // through the slot ignores the fulfillment payload).
        checkExpr(e.value);
        if (e.value.type.kind !== "promise") {
          err("promiseVoidWiden over a non-promise operand", e.loc);
        }
        if (e.type.kind !== "promise" || e.type.inner.kind !== "void") {
          err("promiseVoidWiden must be promise<void>-typed", e.loc);
        }
        break;
      }
      case "upcast":
      case "downcast": {
        // A pointer reinterpret is sound exactly between hierarchy
        // relatives: upcast widens a STRICT descendant to an ancestor,
        // downcast (checker-trusted) narrows an ancestor to a STRICT
        // descendant. Upcast additionally widens CLASS VALUES
        // (classval:D → classval:C): the same pointer, type-only — legal
        // exactly when D strictly descends from C AND the two completed
        // constructor ABIs agree (what newValue completion rests on).
        checkExpr(e.value);
        if (e.kind === "upcast" && e.type.kind === "func" && e.value.type.kind === "func") {
          const source = e.value.type;
          const target = e.type;
          if (
            source.rest !== target.rest ||
            source.restAbi !== target.restAbi ||
            source.argumentsAll !== target.argumentsAll ||
            source.params.length !== target.params.length ||
            !source.params.every((param, i) => typeEquals(param, target.params[i]!)) ||
            source.ret.kind !== "object" ||
            target.ret.kind !== "object" ||
            !isStrictSubclass(source.ret.className, target.ret.className)
          )
            err(
              "function upcast requires identical parameters and a covariant class return",
              e.loc,
            );
          break;
        }
        if (e.kind === "upcast" && e.type.kind === "classval" && e.value.type.kind === "classval") {
          const [sub, sup] = [e.value.type.className, e.type.className];
          if (!isPhysicalSubclass(sub, sup)) {
            err(`upcast: "${sub}" does not extend "${sup}"`, e.loc);
            break;
          }
          const subCtor = functions.get(`%${sub}.constructor`);
          const supCtor = functions.get(`%${sup}.constructor`);
          if (!subCtor || !supCtor) {
            err(`classval upcast: "${sub}"/"${sup}" lack constructor functions`, e.loc);
            break;
          }
          const abiEqual =
            subCtor.params.length === supCtor.params.length &&
            subCtor.params.every((p, i) => i === 0 || typeEquals(p.type, supCtor.params[i]!.type));
          if (!abiEqual) {
            err(`classval upcast: "${sub}" and "${sup}" constructor ABIs differ`, e.loc);
          }
          break;
        }
        if (e.type.kind !== "object" || e.value.type.kind !== "object") {
          err(`${e.kind} between non-class types`, e.loc);
          break;
        }
        const [sub, sup] =
          e.kind === "upcast"
            ? [e.value.type.className, e.type.className]
            : [e.type.className, e.value.type.className];
        if (!isStrictSubclass(sub, sup)) {
          err(`${e.kind}: "${sub}" does not extend "${sup}"`, e.loc);
        }
        break;
      }
      case "classRef": {
        const cls = classes.get(e.className);
        if (!cls) {
          err(`classRef to undeclared class "${e.className}"`, e.loc);
          break;
        }
        if (cls.runtime) {
          err(`classRef to runtime-provided class "${e.className}"`, e.loc);
        }
        if (cls.jsName === undefined) {
          err(`classRef to "${e.className}" without a jsName (the class object's .name)`, e.loc);
        }
        // A class value can always be constructed through — the frontend
        // notes the constructor edge at every classRef, so the emitted
        // thunk has a body to call.
        if (!functions.has(`%${e.className}.constructor`)) {
          err(`classRef to "${e.className}" without its constructor function`, e.loc);
        }
        if (!typeEquals(e.type, { kind: "classval", className: e.className })) {
          err(`classRef to "${e.className}" must have that classval type`, e.loc);
        }
        if (
          (e.captures === undefined) !== (cls.localCaptures === undefined) ||
          (e.captures?.length ?? 0) !== (cls.localCaptures?.length ?? 0)
        ) {
          err(`classRef to "${e.className}" must supply its class captures`, e.loc);
        }
        (e.captures ?? []).forEach((id, index) => {
          const local = locals.get(id);
          const wanted = cls.localCaptures?.[index];
          if (!local?.boxed || (wanted && !typeEquals(local.type, wanted.type))) {
            err(`classRef capture "${id}" must name a box with the declared type`, e.loc);
          }
        });
        break;
      }
      case "newValue": {
        checkExpr(e.callee);
        for (const a of e.args) checkExpr(a);
        if (e.callee.type.kind !== "classval") {
          err(`newValue callee must be a class value, got ${e.callee.type.kind}`, e.loc);
          break;
        }
        const cls = e.callee.type.className;
        const ctor = functions.get(`%${cls}.constructor`);
        if (!ctor) {
          err(`newValue on "${cls}": missing constructor function`, e.loc);
          break;
        }
        // Count-exact against the static class's completed ABI (every
        // value legally in the slot shares it — the upcast rule).
        if (ctor.params.length !== e.args.length + 1) {
          err(
            `newValue on "${cls}": ${e.args.length} args, ctor expects ${ctor.params.length - 1}`,
            e.loc,
          );
        }
        e.args.forEach((a, i) => {
          const p = ctor.params[i + 1];
          if (p) expectType(a, p.type, `newValue on "${cls}" arg ${i}`);
        });
        if (!typeEquals(e.type, { kind: "object", className: cls })) {
          err(`newValue on "${cls}" must have that object type`, e.loc);
        }
        break;
      }
      case "instanceOfValue": {
        checkExpr(e.value);
        checkExpr(e.classValue);
        if (e.type.kind !== "bool") err("instanceOfValue must be bool", e.loc);
        if (e.classValue.type.kind !== "classval") {
          err(`instanceOfValue target must be a class value, got ${e.classValue.type.kind}`, e.loc);
          break;
        }
        // Both sides must be hierarchy members: the operand needs a vt
        // word to read; a standalone target class has one possible value
        // and the frontend folds it statically.
        if (
          classes.get(e.classValue.type.className)?.localCaptures !== undefined &&
          e.value.type.kind === "object" &&
          classes.get(e.value.type.className)?.localCaptures !== undefined
        )
          break;
        if (!hierarchy.has(e.classValue.type.className)) {
          err(`instanceOfValue against standalone class "${e.classValue.type.className}"`, e.loc);
        }
        if (e.value.type.kind !== "object" || !hierarchy.has(e.value.type.className)) {
          err("instanceOfValue operand is not a hierarchy class instance", e.loc);
        }
        break;
      }
      case "instanceOf": {
        checkExpr(e.value);
        if (e.type.kind !== "bool") err("instanceOf must be bool", e.loc);
        if (!hierarchy.has(e.className)) {
          err(`instanceOf against non-hierarchy class "${e.className}"`, e.loc);
        }
        if (e.value.type.kind !== "object" || !hierarchy.has(e.value.type.className)) {
          err("instanceOf operand is not a hierarchy class instance", e.loc);
        }
        break;
      }
      case "virtualCall": {
        // args[0] is the receiver, typed exactly as the static class; the
        // call is well-formed against the NEAREST declaration at/above it,
        // and dynamic dispatch must be reachable: some strict descendant
        // overrides the method (otherwise the frontend devirtualizes).
        for (const a of e.args) checkExpr(a);
        const recv = e.args[0];
        if (!recv || !typeEquals(recv.type, { kind: "object", className: e.className })) {
          err(`virtualCall receiver must be object:${e.className}`, e.loc);
          break;
        }
        // The nearest declaration may be ABSTRACT (no function): the call
        // is then well-formed against any concrete override below — the
        // frontend's override-exactness rule makes every implementation
        // ABI-identical, so any one of them carries the slot's signature.
        const info = virtualCallInfo(e.className, e.method);
        if (!info.declared) {
          err(`virtualCall ${e.className}.${e.method}: no declaration on the base chain`, e.loc);
          break;
        }
        if (!info.hasOverride) {
          err(
            `virtualCall ${e.className}.${e.method}: no concrete override below the static class`,
            e.loc,
          );
        }
        const impl = info.implementation;
        if (!impl) {
          err(`virtualCall ${e.className}.${e.method}: no implementation function exists`, e.loc);
          break;
        }
        if (impl.params.length !== e.args.length) {
          err(
            `virtualCall ${e.className}.${e.method}: ${e.args.length} args, method expects ${impl.params.length}`,
            e.loc,
          );
        }
        e.args.slice(1).forEach((a, i) => {
          const p = impl.params[i + 1];
          if (p) expectType(a, p.type, `virtualCall ${e.className}.${e.method} arg ${i}`);
        });
        const returned = callSiteReturnType(impl);
        if (
          !typeEquals(e.type, returned) &&
          !(
            e.type.kind === "object" &&
            returned.kind === "object" &&
            isStrictSubclass(returned.className, e.type.className)
          )
        ) {
          err(`virtualCall ${e.className}.${e.method} result type mismatch`, e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkRecordExpr(
    e: IrExpr & {
      kind:
        | "recordLit"
        | "recordClone"
        | "recordGet"
        | "recordKeyGet"
        | "recordOvfHas"
        | "recordOvfKeys"
        | "recordHas"
        | "fieldAbsent";
    },
  ): void {
    switch (e.kind) {
      case "recordLit": {
        if (e.type.kind !== "record") {
          err(`recordLit must be record-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        const shape = records.get(e.type.shapeId);
        if (!shape) {
          err(`recordLit of undeclared shape "${e.type.shapeId}"`, e.loc);
          break;
        }
        const want = recordValidation.get(shape.id)!.initializationFields;
        const seen = new Set<string>();
        for (const f of e.fields) {
          if (f.drop || f.overflow) checkExpr(f.value);
          else checkSlotValue(f.value);
          if (seen.has(f.name)) err(`recordLit initializes field "${f.name}" twice`, e.loc);
          seen.add(f.name);
          if (f.drop) {
            // A mapping-dropped field (the PromiseSettledResult honest
            // subset): evaluated, never stored — it must NOT name a
            // declared field (that would silently drop a real store),
            // and its value may be any type, void included.
            if (f.overflow) err(`recordLit drop entry "${f.name}" flagged overflow too`, e.loc);
            if (want.has(f.name)) {
              err(
                `recordLit drop entry "${f.name}" shadows a declared field of shape ${shape.id}`,
                e.loc,
              );
            }
            continue;
          }
          if (f.overflow) {
            // Overflow entries exist only on index-signature shapes, name
            // no declared field, and carry the index-value type exactly
            // (the frontend converts/coerces before constructing).
            if (!shape.indexValue) {
              err(
                `recordLit overflow entry "${f.name}" on non-index-signature shape ${shape.id}`,
                e.loc,
              );
            } else if (want.has(f.name)) {
              err(`recordLit overflow entry "${f.name}" shadows a declared field`, e.loc);
            } else {
              expectType(f.value, shape.indexValue, `recordLit overflow entry "${f.name}"`);
            }
            continue;
          }
          const ft = want.get(f.name);
          if (!ft) err(`shape ${shape.id} has no field "${f.name}"`, e.loc);
          else expectType(f.value, ft, `recordLit field "${f.name}"`);
        }
        if (e.fields.filter((f) => !f.overflow && !f.drop).length !== shape.fields.length) {
          err(`recordLit does not initialize every field of shape ${shape.id}`, e.loc);
        }
        break;
      }
      case "recordClone": {
        checkExpr(e.source);
        if (e.type.kind !== "record") {
          err(`recordClone must be record-typed, got ${e.type.kind}`, e.loc);
          break;
        }
        const shape = records.get(e.type.shapeId);
        if (!shape) {
          err(`recordClone of undeclared shape "${e.type.shapeId}"`, e.loc);
          break;
        }
        if (shape.tuple || shape.indexValue || recordValidation.get(shape.id)!.hasAccessorSlots) {
          err(`recordClone requires a plain declared-field shape, got ${shape.id}`, e.loc);
        }
        expectType(e.source, e.type, "recordClone source");
        const want = recordValidation.get(shape.id)!.initializationFields;
        const seen = new Set<string>();
        for (const f of e.overrides) {
          checkSlotValue(f.value);
          if (seen.has(f.name)) err(`recordClone overrides field "${f.name}" twice`, e.loc);
          seen.add(f.name);
          const ft = want.get(f.name);
          if (!ft) err(`shape ${shape.id} has no field "${f.name}"`, e.loc);
          else expectType(f.value, ft, `recordClone field "${f.name}"`);
        }
        break;
      }
      case "recordHas": {
        checkExpr(e.obj);
        const shape = records.get(e.shapeId);
        if (!shape) err(`recordHas on undeclared shape "${e.shapeId}"`, e.loc);
        else if (!recordValidation.get(e.shapeId)?.fields.has(e.field))
          err(`shape ${e.shapeId} has no field "${e.field}"`, e.loc);
        expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordHas receiver");
        if (e.type.kind !== "bool") err("recordHas must be bool", e.loc);
        break;
      }
      case "fieldAbsent": {
        const def = unions.get(e.unionId);
        if (!def) err(`fieldAbsent of undeclared union "${e.unionId}"`, e.loc);
        else if (!def.arms.some((arm) => arm.kind === "undefinedT"))
          err(`fieldAbsent of ${e.unionId}: the union has no undefined arm`, e.loc);
        if (e.type.kind !== "union" || e.type.unionId !== e.unionId)
          err("fieldAbsent must have its union type", e.loc);
        if (!fieldSlotValues.has(e)) err("fieldAbsent outside a record field write", e.loc);
        break;
      }
      case "recordGet": {
        checkExpr(e.obj);
        const shape = records.get(e.shapeId);
        const field = recordValidation.get(e.shapeId)?.fields.get(e.field);
        if (!shape) err(`recordGet on undeclared shape "${e.shapeId}"`, e.loc);
        else if (!field) err(`shape ${e.shapeId} has no field "${e.field}"`, e.loc);
        else {
          expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordGet receiver");
          if (!typeEquals(e.type, field)) {
            err(`recordGet ${e.shapeId}.${e.field} type mismatch`, e.loc);
          }
        }
        break;
      }
      case "recordKeyGet": {
        checkExpr(e.obj);
        checkExpr(e.key);
        const shape = records.get(e.shapeId);
        if (!shape) {
          err(`recordKeyGet on undeclared shape "${e.shapeId}"`, e.loc);
          break;
        }
        if (shape.tuple) err(`recordKeyGet on tuple shape ${e.shapeId}`, e.loc);
        expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordKeyGet receiver");
        expectType(e.key, STRING, "recordKeyGet key");
        // Every reachable value must SURFACE as the result type: identity,
        // an arm of a union result, or (dyn results) a dyn conversion —
        // the frontend's recordKeyResultOk mirror. overflowOnly reads (a
        // literal key naming no declared field) skip the declared check
        // and require the overflow to exist.
        const surfaces = (t: IrType): boolean =>
          typeEquals(t, e.type) ||
          (e.type.kind === "union" &&
            (() => {
              const result = unions.get(e.type.unionId);
              const source = t.kind === "union" ? unions.get(t.unionId) : undefined;
              return (
                !!result &&
                (result.arms.some((a) => typeEquals(a, t)) ||
                  (!!source && unionWideningTags(source.arms, result.arms) !== null))
              );
            })()) ||
          e.type.kind === "dyn";
        if (e.overflowOnly && !shape.indexValue) {
          err(
            `recordKeyGet on ${e.shapeId}: overflowOnly read of a shape without an index signature`,
            e.loc,
          );
        }
        if (!e.overflowOnly && !shape.fields.every((f) => surfaces(f.type))) {
          err(
            `recordKeyGet on ${e.shapeId}: a declared field cannot surface as the result type`,
            e.loc,
          );
        }
        if (e.type.kind === "dyn" && shape.indexValue && shape.indexValue.kind !== "dyn") {
          err(`recordKeyGet on ${e.shapeId}: dyn result over a non-dyn index value`, e.loc);
        }
        if (shape.indexValue && e.type.kind !== "dyn" && !surfaces(shape.indexValue)) {
          err(
            `recordKeyGet on ${e.shapeId}: the overflow value cannot surface as the result type`,
            e.loc,
          );
        }
        break;
      }
      case "recordOvfHas": {
        checkExpr(e.obj);
        checkExpr(e.key);
        const shape = records.get(e.shapeId);
        if (!shape) err(`recordOvfHas on undeclared shape "${e.shapeId}"`, e.loc);
        else if (!shape.indexValue || shape.tuple)
          err(`recordOvfHas on ${e.shapeId}: requires an index-signature record`, e.loc);
        expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordOvfHas receiver");
        expectType(e.key, STRING, "recordOvfHas key");
        if (e.type.kind !== "bool") err("recordOvfHas must be bool", e.loc);
        break;
      }
      case "recordOvfKeys": {
        checkExpr(e.obj);
        const shape = records.get(e.shapeId);
        if (!shape) {
          err(`recordOvfKeys on undeclared shape "${e.shapeId}"`, e.loc);
          break;
        }
        if (!shape.indexValue) err(`recordOvfKeys on ${e.shapeId}: no index signature`, e.loc);
        expectType(e.obj, { kind: "record", shapeId: e.shapeId }, "recordOvfKeys receiver");
        if (e.type.kind !== "array" || e.type.elem.kind !== "string") {
          err("recordOvfKeys must be string[]", e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkDynamicExpr(
    e: IrExpr & {
      kind:
        | "dynFrom"
        | "dynFromJsval"
        | "dynCall"
        | "dynInvoke"
        | "dynObjLit"
        | "dynArrLit"
        | "unionWrap"
        | "dynTest"
        | "dynKeyGet"
        | "dynHasKey"
        | "dynScalarEq"
        | "caughtTest"
        | "caughtCheck"
        | "caughtToDyn"
        | "caughtNarrow";
    },
  ): void {
    switch (e.kind) {
      case "dynFrom": {
        if (e.type.kind !== "dyn") err(`dynFrom must be dyn-typed, got ${e.type.kind}`, e.loc);
        // A bare unit literal is legal exactly here (like unionWrap): the
        // dyn has first-class undefined/null values.
        if (e.value.kind === "unitLit") {
          const want = e.value.unit === "undefined" ? "undefinedT" : "nullT";
          if (e.value.type.kind !== want) {
            err(`unitLit '${e.value.unit}' typed ${e.value.type.kind}`, e.loc);
          }
          break;
        }
        checkExpr(e.value);
        // Domain: JSON-safe, bytes<u8> (the checked-dynamic tree's bytes kind — payload
        // copied), an undefined-armed union of JSON-safe arms (the
        // undefined arm becomes the undefined dyn value), or a BOXABLE
        // function type (the checked-dynamic tree's function kind — canConvertToDyn folds
        // all four in).
        const vt = e.value.type;
        if (
          !canConvertToDyn(
            vt,
            (id) => records.get(id),
            (id) => unions.get(id),
          )
        ) {
          err(`dynFrom of non-dyn-convertible type ${vt.kind}`, e.loc);
        }
        if (e.liveRef && !liveDynRefEligible(vt)) {
          err(`live dynFrom of unsupported type ${vt.kind}`, e.loc);
        }
        break;
      }
      case "dynFromJsval": {
        // The jsval→dyn crossing: exactly a jsval operand into a dyn
        // result (the by-reference island wrap; scalars normalize at
        // runtime).
        checkExpr(e.value);
        if (e.type.kind !== "dyn") err(`dynFromJsval must be dyn-typed, got ${e.type.kind}`, e.loc);
        if (e.value.type.kind !== "jsval") {
          err(`dynFromJsval operand must be jsval, got ${e.value.type.kind}`, e.loc);
        }
        break;
      }
      case "dynCall": {
        checkExpr(e.callee);
        if (e.calleeNameValue !== undefined) {
          checkExpr(e.calleeNameValue);
          expectType(e.calleeNameValue, STRING, "dynCall callee name");
        }
        if (e.receiver !== undefined) {
          checkExpr(e.receiver);
          expectType(e.receiver, DYN, "dynCall receiver");
        }
        expectType(e.callee, DYN, "dynCall callee");
        if (e.type.kind !== "dyn") err(`dynCall must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const a of e.args) {
          checkExpr(a);
          if (a.type.kind !== "dyn")
            err(`dynCall argument of kind ${a.type.kind} (must be dyn)`, e.loc);
        }
        // The runtime-arity form: spread entries point into args (their
        // dyn values flatten at the call), strictly increasing.
        if (e.spreads !== undefined) {
          if (e.spreads.length === 0) err("dynCall spreads must be non-empty when present", e.loc);
          let prev = -1;
          for (const s of e.spreads) {
            if (!Number.isInteger(s.arg) || s.arg < 0 || s.arg >= e.args.length) {
              err(`dynCall spread index ${s.arg} out of range`, e.loc);
            }
            if (s.arg <= prev) err("dynCall spread indices must be strictly increasing", e.loc);
            prev = s.arg;
          }
        }
        break;
      }
      case "dynInvoke": {
        checkExpr(e.recv);
        if (e.calleeNameValue !== undefined) {
          checkExpr(e.calleeNameValue);
          expectType(e.calleeNameValue, STRING, "dynInvoke callee name");
        }
        expectType(e.recv, DYN, "dynInvoke receiver");
        if (e.type.kind !== "dyn") err(`dynInvoke must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const a of e.args) {
          checkExpr(a);
          if (a.type.kind !== "dyn")
            err(`dynInvoke argument of kind ${a.type.kind} (must be dyn)`, e.loc);
        }
        break;
      }
      case "dynObjLit":
        if (e.type.kind !== "dyn") err(`dynObjLit must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const f of e.fields ?? []) {
          checkExpr(f.key);
          if (f.key.type.kind !== "string" && f.key.type.kind !== "dyn")
            err(`dynObjLit key of kind ${f.key.type.kind} (must be string or dyn)`, e.loc);
          checkExpr(f.value);
          if (f.value.type.kind !== "dyn")
            err(`dynObjLit field value of kind ${f.value.type.kind} (must be dyn)`, e.loc);
        }
        break;
      case "dynArrLit": {
        if (e.type.kind !== "dyn") err(`dynArrLit must be dyn-typed, got ${e.type.kind}`, e.loc);
        for (const el of e.elems) {
          checkExpr(el);
          if (el.type.kind !== "dyn")
            err(`dynArrLit element of kind ${el.type.kind} (must be dyn)`, e.loc);
        }
        break;
      }
      case "unionWrap": {
        // A unitLit is legal exactly HERE: validate it inline (checkExpr
        // rejects bare ones) — the unit spelling must agree with its type,
        // and the generic arm/type agreement below covers the rest.
        if (e.value.kind === "unitLit") {
          const want = e.value.unit === "undefined" ? "undefinedT" : "nullT";
          if (e.value.type.kind !== want) {
            err(`unitLit '${e.value.unit}' typed ${e.value.type.kind}`, e.loc);
          }
        } else {
          checkExpr(e.value);
          if (isUnitType(e.value.type)) {
            err(`unionWrap of a non-literal unit value (${e.value.kind})`, e.loc);
          }
        }
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionWrap of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        if (!typeEquals(e.type, { kind: "union", unionId: e.unionId })) {
          err(`unionWrap type ${e.type.kind} != union ${e.unionId}`, e.loc);
        }
        const arm = def.arms[e.tag];
        if (!Number.isInteger(e.tag) || !arm) {
          err(`unionWrap tag ${e.tag} out of range for union ${e.unionId}`, e.loc);
        } else if (e.value.type.kind === "void") {
          // A VOID payload: the backends evaluate the operand for its
          // effects and produce the interned unit instance — legal only
          // against the undefined arm (JS's void value IS undefined).
          if (arm.kind !== "undefinedT") {
            err(
              `unionWrap of a void value against non-undefined arm ${e.tag} of ${e.unionId}`,
              e.loc,
            );
          }
        } else if (!typeEquals(e.value.type, arm)) {
          err(`unionWrap value ${e.value.type.kind} != arm ${e.tag} of ${e.unionId}`, e.loc);
        }
        break;
      }
      case "dynTest": {
        checkExpr(e.value);
        expectType(e.value, { kind: "dyn" }, "dynTest operand");
        if (e.type.kind !== "bool") err("dynTest must be bool", e.loc);
        if (
          e.bytesElem !== undefined &&
          (e.test !== "bytes" || !Object.hasOwn(BYTES_ELEMENT_NAME, e.bytesElem))
        ) {
          err("dynTest bytesElem requires a valid bytes test", e.loc);
        }
        break;
      }
      case "dynKeyGet": {
        checkExpr(e.value);
        checkExpr(e.key);
        expectType(e.value, { kind: "dyn" }, "dynKeyGet operand");
        if (e.key.type.kind !== "string" && e.key.type.kind !== "dyn")
          err(`dynKeyGet key is ${e.key.type.kind}, not string or dyn`, e.loc);
        if (e.type.kind !== "dyn") err("dynKeyGet must be dyn", e.loc);
        break;
      }
      case "dynHasKey": {
        checkExpr(e.value);
        expectType(e.value, { kind: "dyn" }, "dynHasKey operand");
        if (e.type.kind !== "bool") err("dynHasKey must be bool", e.loc);
        break;
      }
      case "dynScalarEq": {
        checkExpr(e.left);
        checkExpr(e.right);
        const dynSide = e.left.type.kind === "dyn" ? e.left : e.right;
        const scalarSide = dynSide === e.left ? e.right : e.left;
        if (dynSide.type.kind !== "dyn") err("dynScalarEq needs a dyn side", e.loc);
        if (!["f64", "string", "bool", "dyn"].includes(scalarSide.type.kind)) {
          err(`dynScalarEq scalar side is ${scalarSide.type.kind}`, e.loc);
        }
        if (e.type.kind !== "bool") err("dynScalarEq must be bool", e.loc);
        break;
      }
      case "caughtTest": {
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtTest operand");
        if (e.type.kind !== "bool") err("caughtTest must be bool", e.loc);
        if (e.test === "instanceof") {
          if (!e.className) err("caughtTest instanceof without a class", e.loc);
          else if (!classes.has(e.className)) {
            err(`caughtTest instanceof against undeclared class "${e.className}"`, e.loc);
          }
        } else if (e.className !== undefined) {
          err(`caughtTest ${e.test} with a class name`, e.loc);
        }
        break;
      }
      case "caughtCheck": {
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtCheck operand");
        if (!hierarchy.has(e.className)) {
          err(`caughtCheck against non-hierarchy class "${e.className}"`, e.loc);
        }
        if (e.type.kind !== "object" || e.type.className !== e.className) {
          err("caughtCheck type must be the checked class's object type", e.loc);
        }
        break;
      }
      case "caughtToDyn": {
        // The caught snapshot converting to a dyn value (an unknown
        // slot): operand caught, result dyn — the runtime dispatch handles
        // every payload kind, so nothing else constrains it.
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtToDyn operand");
        if (e.type.kind !== "dyn") err(`caughtToDyn must be dyn-typed, got ${e.type.kind}`, e.loc);
        break;
      }
      case "caughtNarrow": {
        checkExpr(e.value);
        expectType(e.value, { kind: "caught" }, "caughtNarrow operand");
        const t = e.type;
        const ok =
          t.kind === "f64" ||
          t.kind === "bool" ||
          t.kind === "string" ||
          (t.kind === "object" && classes.has(t.className));
        if (!ok) {
          err(
            `caughtNarrow to ${t.kind === "object" ? `undeclared class "${t.className}"` : t.kind}`,
            e.loc,
          );
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkUnionExpr(
    e: IrExpr & { kind: "unionNarrow" | "unionDisc" | "unionKeyGet" | "unionIsTag" },
  ): void {
    switch (e.kind) {
      case "unionNarrow": {
        checkExpr(e.value);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionNarrow of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionNarrow operand");
        const arm = def.arms[e.tag];
        if (!Number.isInteger(e.tag) || !arm) {
          err(`unionNarrow tag ${e.tag} out of range for union ${e.unionId}`, e.loc);
        } else if (!typeEquals(e.type, arm)) {
          err(`unionNarrow type ${e.type.kind} != arm ${e.tag} of ${e.unionId}`, e.loc);
        } else if (isUnitType(arm)) {
          // A unit arm has no payload: narrowing to it produces no value,
          // so the frontend never emits this (it leaves the union-typed
          // expression alone in unit-narrowed branches).
          err(`unionNarrow to unit arm ${e.tag} of ${e.unionId}`, e.loc);
        }
        break;
      }
      case "unionDisc": {
        checkExpr(e.value);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionDisc of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionDisc receiver");
        // Any representable field type reads through the tag switch (the
        // emitter retains ref results uniformly); units/void can never be
        // record/class field types and have no C value form.
        if (e.type.kind === "void" || e.type.kind === "undefinedT" || e.type.kind === "nullT") {
          err(`unionDisc of valueless type ${e.type.kind}`, e.loc);
        }
        def.arms.forEach((arm, i) => {
          const fieldType =
            arm.kind === "record"
              ? recordValidation.get(arm.shapeId)?.fields.get(e.field)
              : arm.kind === "object"
                ? classValidation.fields.get(arm.className)?.get(e.field)
                : undefined;
          if (!fieldType) {
            err(`unionDisc: arm ${i} of ${e.unionId} has no field "${e.field}"`, e.loc);
          } else if (!typeEquals(fieldType, e.type)) {
            err(
              `unionDisc: arm ${i} field "${e.field}" is ${fieldType.kind}, not ${e.type.kind}`,
              e.loc,
            );
          }
        });
        break;
      }
      case "unionKeyGet": {
        checkExpr(e.value);
        checkExpr(e.key);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionKeyGet of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionKeyGet receiver");
        if (e.key.type.kind !== "string" && e.key.type.kind !== "f64") {
          err(`unionKeyGet key is ${e.key.type.kind}, not string/number`, e.loc);
        }
        if (e.type.kind === "void" || e.type.kind === "undefinedT" || e.type.kind === "nullT") {
          err(`unionKeyGet of valueless type ${e.type.kind}`, e.loc);
        }
        // Per-arm answerability: the frontend joined the answers into
        // e.type — every arm must surface as it (equal or one of its arms),
        // unit arms need the undefined arm, and non-record/non-array/
        // non-unit arms have no keyed read at all. Number keys read ARRAY
        // arms; string keys read RECORD arms.
        const resultUnion = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
        const surfaces = (t: IrType): boolean =>
          typeEquals(t, e.type) ||
          !!resultUnion?.arms.some((a) => typeEquals(a, t)) ||
          (t.kind === "union" &&
            !!resultUnion &&
            (() => {
              const source = unions.get(t.unionId);
              return !!source && unionWideningTags(source.arms, resultUnion.arms) !== null;
            })());
        def.arms.forEach((arm, i) => {
          if (arm.kind === "undefinedT" || arm.kind === "nullT") {
            if (!resultUnion?.arms.some((a) => a.kind === "undefinedT")) {
              err(
                `unionKeyGet: unit arm ${i} of ${e.unionId} needs an undefined arm in the result`,
                e.loc,
              );
            }
            return;
          }
          if (e.key.type.kind === "f64") {
            if (arm.kind !== "array") {
              err(
                `unionKeyGet: number-keyed arm ${i} of ${e.unionId} is ${arm.kind}, not an array`,
                e.loc,
              );
            } else if (!surfaces(arm.elem)) {
              err(
                `unionKeyGet: arm ${i} element ${arm.elem.kind} cannot surface as the result`,
                e.loc,
              );
            }
            return;
          }
          if (arm.kind !== "record") {
            err(`unionKeyGet: arm ${i} of ${e.unionId} is ${arm.kind}, not a record`, e.loc);
            return;
          }
          const shape = records.get(arm.shapeId);
          if (!shape) {
            err(`unionKeyGet: arm ${i} of unknown shape ${arm.shapeId}`, e.loc);
            return;
          }
          const literal = e.key.kind === "strLit" ? e.key.value : null;
          const declared =
            literal !== null ? recordValidation.get(shape.id)?.fields.get(literal) : undefined;
          if (declared) {
            if (!surfaces(declared)) {
              err(
                `unionKeyGet: arm ${i} field "${literal}" of type ${declared.kind} cannot surface as the result`,
                e.loc,
              );
            }
            return;
          }
          if (!shape.indexValue && !(literal === null && shape.fields.length > 0)) {
            err(`unionKeyGet: arm ${i} of ${e.unionId} has no answer for the key`, e.loc);
          }
        });
        break;
      }
      case "unionIsTag": {
        checkExpr(e.value);
        const def = unions.get(e.unionId);
        if (!def) {
          err(`unionIsTag of undeclared union "${e.unionId}"`, e.loc);
          break;
        }
        expectType(e.value, { kind: "union", unionId: e.unionId }, "unionIsTag operand");
        if (!Number.isInteger(e.tag) || !def.arms[e.tag]) {
          err(`unionIsTag tag ${e.tag} out of range for union ${e.unionId}`, e.loc);
        }
        if (e.type.kind !== "bool") err("unionIsTag must be bool", e.loc);
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkIntrinsicExpr(e: IrExpr & { kind: "intrinsic" }): void {
    if (e.name === "module.tdzCheck") {
      const [flag, name] = e.args;
      if (e.args.length !== 2 || flag === undefined || name?.kind !== "strLit") {
        err("module.tdzCheck takes a flag and a binding-name literal", e.loc);
        return;
      }
      checkExpr(flag);
      if (flag.type.kind !== "bool") err("module.tdzCheck flag must be bool", e.loc);
      if (e.type.kind !== "void") err("module.tdzCheck must be void", e.loc);
      return;
    }
    if (e.name === "module.await") {
      if (e.args.length !== 1) err("module.await takes exactly one argument", e.loc);
      for (const a of e.args) {
        checkExpr(a);
        if (a.type.kind !== "promise" || a.type.inner.kind !== "void") {
          err(`${typeKey(a.type)} argument to module.await (needs promise<void>)`, a.loc);
        }
      }
      if (e.type.kind !== "void") err("module.await must be void", e.loc);
      return;
    }
    if (e.name === "promise.all") {
      // ONE argument: an array of promises whose inner type is the
      // result's array element (or void, collapsing to promise<void>).
      // The exact-inner-type rule is the frontend's fence; the coarse
      // shape keeps hand-written IR honest.
      if (e.args.length !== 1) err("promise.all takes exactly one argument", e.loc);
      for (const a of e.args) {
        checkExpr(a);
        if (a.type.kind !== "array" || a.type.elem.kind !== "promise") {
          err(`${a.type.kind} argument to promise.all (needs an array of promises)`, a.loc);
        }
      }
      if (e.type.kind !== "promise") err("promise.all must be promise-typed", e.loc);
      else if (e.type.inner.kind !== "array" && e.type.inner.kind !== "void") {
        err("promise.all result must be a promise of an array (or void)", e.loc);
      }
      return;
    }
    if (e.name === "promise.reject") {
      // ONE argument: the %Error-rooted reason object (the rejection
      // payload shares the thrown-Error representation — the
      // frontend's fence pins the hierarchy; the coarse object shape
      // keeps hand-written IR honest) or a checked-dynamic reason
      // (the thrown-dyn representation — identity flows to catch and
      // unhandledRejection observers). The result is the
      // context-named promise.
      if (e.args.length !== 1) err("promise.reject takes exactly one argument", e.loc);
      for (const a of e.args) {
        checkExpr(a);
        if (a.type.kind !== "object" && a.type.kind !== "dyn") {
          err(
            `${a.type.kind} argument to promise.reject (needs an Error object or a dyn reason)`,
            a.loc,
          );
        }
      }
      if (e.type.kind !== "promise") err("promise.reject must be promise-typed", e.loc);
      return;
    }
    if (e.name === "promise.resolve") {
      // Zero args (Promise<void>) or one plain value of the result's
      // inner type — promise arguments never reach the intrinsic
      // (the frontend returns them as-is).
      if (e.args.length > 1) err("promise.resolve takes at most one argument", e.loc);
      for (const a of e.args) {
        checkExpr(a);
        if (a.type.kind === "promise") {
          err("promise argument to promise.resolve (identity belongs in the frontend)", a.loc);
        }
      }
      if (e.type.kind !== "promise") err("promise.resolve must be promise-typed", e.loc);
      else if (e.args.length === 0 && e.type.inner.kind !== "void") {
        err("zero-argument promise.resolve must be promise<void>", e.loc);
      } else if (e.args.length === 1 && !typeEquals(e.args[0]!.type, e.type.inner)) {
        err("promise.resolve argument must be the result's inner type", e.loc);
      }
      return;
    }
    if (e.name === "promise.race") {
      // Entries are promises; the result is the combined promise. The
      // per-entry inner-type compatibility (equal to the result inner,
      // one of its union arms, or a sub-union of it) is the frontend's
      // fence; here the coarse shape keeps hand-written IR honest.
      if (e.args.length === 0) err("promise.race with no entries", e.loc);
      for (const a of e.args) {
        checkExpr(a);
        if (a.type.kind !== "promise") {
          err(`${a.type.kind} entry in promise.race`, a.loc);
        }
      }
      if (e.type.kind !== "promise") err("promise.race must be promise-typed", e.loc);
      return;
    }
    for (const a of e.args) {
      checkExpr(a);
      // Arrays/functions/records/unions stay out of console.log (and
      // its stderr twin console.error) by design (the ambient signature
      // accepts number|string|boolean; a union of those satisfies it,
      // so the frontend rejects union args explicitly) — inspect
      // formatting is unimplemented, so the backend must never see one.
      if (a.type.kind !== "f64" && a.type.kind !== "string" && a.type.kind !== "bool") {
        err(`${a.type.kind} argument to ${e.name}`, a.loc);
      }
    }
    if (e.type.kind !== "void") err(`${e.name} must be void`, e.loc);
  }

  function checkLibCall(e: IrExpr & { kind: "libCall" }): void {
    if (
      e.fn === "atomics.op" &&
      (e.args[0]?.type.kind !== "bytes" ||
        !["u8", "i8", "u16", "i16", "u32", "i32"].includes(e.args[0].type.elem))
    ) {
      errors.push({ message: "integer Atomics require an integer typed array", loc: e.loc });
    }
    if (e.fn === "worker.new" && !workers)
      errors.push({ message: "Worker construction requires worker execution mode", loc: e.loc });
    const sig = LIB_FN_SIGS[e.fn];
    if (!sig) {
      err(`libCall of unknown library function "${e.fn as string}"`, e.loc);
      return;
    }
    // emitter.emit is variadic: (recv, name) plus the event's tuple.
    // The stream constructors (trailing option callbacks), write/end
    // (the optional chunk/cb tail), and unpipe (the optional
    // destination) admit a longer list the same way.
    const variadic =
      e.fn === "emitter.emit" ||
      e.fn === "emitter.emitFlex" ||
      e.fn === "readable.new" ||
      e.fn === "writable.new" ||
      e.fn === "duplex.new" ||
      e.fn === "transform.new" ||
      e.fn === "passthrough.new" ||
      e.fn === "readable.init" ||
      e.fn === "writable.init" ||
      e.fn === "duplex.init" ||
      e.fn === "transform.init" ||
      e.fn === "passthrough.init" ||
      e.fn === "readable.initDyn" ||
      e.fn === "writable.initDyn" ||
      e.fn === "duplex.initDyn" ||
      e.fn === "transform.initDyn" ||
      e.fn === "passthrough.initDyn" ||
      e.fn === "stream.pipeline" ||
      e.fn === "stream.pipelineDyn" ||
      e.fn === "sp.pipeline" ||
      e.fn === "writable.write" ||
      e.fn === "writable.writeStr" ||
      e.fn === "writable.writeU" ||
      e.fn === "writable.end" ||
      e.fn === "readable.unpipe";
    if (variadic ? e.args.length < sig.argTypes.length : e.args.length !== sig.argTypes.length) {
      err(`libCall ${e.fn}: ${e.args.length} args, expected ${sig.argTypes.length}`, e.loc);
    }
    e.args.forEach((a, i) => {
      checkExpr(a);
      const want = sig.argTypes[i];
      if (want) expectType(a, want, `libCall ${e.fn} arg ${i}`);
    });
    if (checkLibValueCall(e)) return;
    if (checkLibNetworkCall(e)) return;
    if (checkLibFileCall(e)) return;
    if (checkLibProcessCall(e)) return;
    if (checkLibSpecialCall(e)) return;
    if (checkLibStreamCall(e, sig.argTypes.length, sig.result)) return;
    if (checkLibEmitterCall(e, sig.result)) return;
    if (
      e.fn === "error.stack" ||
      e.fn === "error.cause" ||
      e.fn === "error.hasCause" ||
      e.fn === "error.setCause" ||
      e.fn === "error.defineCause" ||
      e.fn === "error.deleteCause"
    ) {
      const recv = e.args[0];
      let cls = recv?.type.kind === "object" ? classes.get(recv.type.className) : undefined;
      while (cls?.base) cls = classes.get(cls.base);
      if (cls?.name !== "%Error") err(`libCall ${e.fn} receiver must be an error object`, e.loc);
    }
    if (e.fn === "error.ctor" || e.fn === "error.ctorOptions" || e.fn === "error.toString") {
      const recv = e.args[0];
      const wantErrorRoot = e.fn === "error.toString";
      const ok =
        recv &&
        isBuiltinErrorObject(recv.type) &&
        (!wantErrorRoot || (recv.type.kind === "object" && recv.type.className === "%Error"));
      if (!ok) {
        err(
          `libCall ${e.fn} receiver must be ${wantErrorRoot ? "'%Error'" : "a builtin error class"}`,
          e.loc,
        );
      }
    }
    if (!typeEquals(e.type, sig.result)) {
      err(`libCall ${e.fn} must be ${sig.result.kind}, got ${e.type.kind}`, e.loc);
    }
  }

  function checkLibValueCall(e: IrExpr & { kind: "libCall" }): boolean {
    if (
      e.fn === "fileHandle.read" ||
      e.fn === "fileHandle.writeBytes" ||
      e.fn === "fileHandle.writeStr" ||
      e.fn === "fileHandle.readv" ||
      e.fn === "fileHandle.writev"
    ) {
      const inner = e.type.kind === "promise" ? e.type.inner : undefined;
      const shape = inner?.kind === "record" ? records.get(inner.shapeId) : undefined;
      const countName =
        e.fn === "fileHandle.read" || e.fn === "fileHandle.readv" ? "bytesRead" : "bytesWritten";
      const payloadName =
        e.fn === "fileHandle.readv" || e.fn === "fileHandle.writev" ? "buffers" : "buffer";
      const payload = e.args[1]?.type;
      const count = shape ? recordValidation.get(shape.id)?.fields.get(countName) : undefined;
      const buffer = shape ? recordValidation.get(shape.id)?.fields.get(payloadName) : undefined;
      const ok =
        shape !== undefined &&
        !shape.tuple &&
        shape.indexValue === undefined &&
        shape.fields.length === 2 &&
        count?.kind === "f64" &&
        payload !== undefined &&
        buffer !== undefined &&
        typeEquals(buffer, payload);
      if (!ok) {
        err(
          `libCall ${e.fn} must return a promise of { ${countName}: number, ${payloadName} }`,
          e.loc,
        );
      }
      return true;
    }
    if (e.fn === "fetch.streamFrom") {
      const t = e.args[0]?.type;
      const ok =
        t?.kind === "string" ||
        (t?.kind === "bytes" && t.elem === "u8") ||
        (t?.kind === "array" &&
          canConvertToDyn(
            t.elem,
            (id) => records.get(id),
            (id) => unions.get(id),
          )) ||
        t?.kind === "dyn";
      if (!ok) {
        err(`libCall fetch.streamFrom arg 0: expected a supported iterable, got ${t?.kind}`, e.loc);
      }
      return true;
    }
    if (e.fn === "fetch.readerRead") {
      if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
        err(`libCall fetch.readerRead must return a promise of a read-result record`, e.loc);
      }
      return true;
    }
    if (e.fn === "fetch.responseText" || e.fn === "fetch.responseBytes") {
      const valueType = e.fn === "fetch.responseText" ? STRING : BYTES_U8;
      const inner = e.type.kind === "promise" ? e.type.inner : null;
      const union = inner?.kind === "union" ? unions.get(inner.unionId) : undefined;
      if (
        inner === null ||
        (!typeEquals(inner, valueType) && !union?.arms.some((arm) => typeEquals(arm, valueType)))
      ) {
        err(`libCall ${e.fn} must return a promise whose value includes ${valueType.kind}`, e.loc);
      }
      return true;
    }
    if (e.fn === "string.fromCharCode" || e.fn === "string.fromCodePoint") {
      // One packed f64[] or one bytes value (the spread form).
      const t = e.args[0]?.type;
      const ok = t && ((t.kind === "array" && t.elem.kind === "f64") || t.kind === "bytes");
      if (!ok) {
        err(`libCall ${e.fn} arg 0: expected number[] or bytes, got ${t?.kind}`, e.loc);
      }
      return true;
    }
    if (e.fn === "process.envGet") {
      // Result is the module's interned `string | undefined` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "string" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall process.envGet must return the 'string | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "process.columns" || e.fn === "process.rows") {
      // Result is the module's interned `number | undefined` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "f64" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall ${e.fn} must return the 'number | undefined' union`, e.loc);
      }
      return true;
    }
    return false;
  }

  function checkLibNetworkCall(e: IrExpr & { kind: "libCall" }): boolean {
    if (e.fn === "http.createServer" || e.fn === "http2.createServerReq") {
      // The request handler: void, at most (req, res) in order.
      const cbT = e.args[0]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 2;
      if (ok && cbT?.kind === "func") {
        const [p0, p1] = cbT.params;
        if (p0 !== undefined && p0.kind !== "httpReq") ok = false;
        if (p1 !== undefined && p1.kind !== "httpRes") ok = false;
      }
      if (!ok) {
        err(`libCall ${e.fn} handler shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.serverOnRequest") {
      // The 'request' listener: the same shape as http.createServer's
      // handler — void, at most (req, res) in order.
      const cbT = e.args[1]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 2;
      if (ok && cbT?.kind === "func") {
        const [p0, p1] = cbT.params;
        if (p0 !== undefined && p0.kind !== "httpReq") ok = false;
        if (p1 !== undefined && p1.kind !== "httpRes") ok = false;
      }
      if (!ok) {
        err(`libCall http.serverOnRequest handler shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http2.serverOnSessionError") {
      const cbT = e.args[1]?.type;
      const ok =
        cbT?.kind === "func" &&
        cbT.ret.kind === "void" &&
        cbT.params.length <= 2 &&
        (cbT.params[0] === undefined ||
          (cbT.params[0].kind === "object" && cbT.params[0].className === "%Error")) &&
        (cbT.params[1] === undefined || cbT.params[1].kind === "http2Session");
      if (!ok) {
        err(`libCall http2.serverOnSessionError callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.reqOnData") {
      const cbT = e.args[1]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        const p = cbT.params[0]!;
        // dyn = the checked-dynamic listener's adapter (the chunk
        // boxes Buffer-flavored in the runtime data thunk).
        ok = (p.kind === "bytes" && p.elem === "u8") || p.kind === "dyn";
      }
      if (!ok) {
        err(`libCall http.reqOnData callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.reqStatusCode") {
      // Result is the module's interned `number | undefined` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "f64" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall http.reqStatusCode must return the 'number | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "net.sockRemoteAddress") {
      // Result is the interned `string | undefined` union (envGet's).
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "string" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall net.sockRemoteAddress must return the 'string | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "net.sockEncrypted") {
      // Result is the interned `boolean | undefined` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "bool" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall net.sockEncrypted must return the 'boolean | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "tls.sockAuthError") {
      // Result is the interned `string | null` union (Node's
      // authorizationError: the verify-failure code string, or null).
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "string" &&
        def.arms[1]!.kind === "nullT";
      if (!ok) {
        err(`libCall tls.sockAuthError must return the 'string | null' union`, e.loc);
      }
      return true;
    }
    if (
      e.fn === "http.requestCb" ||
      e.fn === "https.requestCb" ||
      e.fn === "http.requestUrlCb" ||
      e.fn === "http.clientOnResponse" ||
      e.fn === "http.requestAgentCb" ||
      e.fn === "https.requestAgentCb" ||
      e.fn === "https.requestUrlCb"
    ) {
      // The response listener: void, no params or exactly (res: httpReq).
      const cbT =
        e.args[
          e.fn === "http.requestCb"
            ? 7
            : e.fn === "https.requestCb"
              ? 9
              : e.fn === "http.requestUrlCb" || e.fn === "https.requestUrlCb"
                ? 3
                : e.fn === "http.requestAgentCb"
                  ? 8
                  : e.fn === "https.requestAgentCb"
                    ? 10
                    : 1
        ]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        ok = cbT.params[0]!.kind === "httpReq";
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.reqOnError" || e.fn === "http.clientOnError") {
      // The error listener: void, no params or exactly (err: %Error).
      const cbT = e.args[1]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        const p = cbT.params[0]!;
        ok = p.kind === "object" && p.className === "%Error";
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "net.sockRead") {
      // Result is the interned `Buffer | null` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "bytes" && a.elem === "u8") &&
        def.arms.some((a) => a.kind === "nullT");
      if (!ok) {
        err(`libCall net.sockRead must return the 'Buffer | null' union`, e.loc);
      }
      return true;
    }
    if (
      e.fn === "http.serverOnUpgrade" ||
      e.fn === "http.clientOnUpgrade" ||
      e.fn === "http.serverOnConnect"
    ) {
      // (req, socket, head) or any shorter prefix, void return. The
      // 'connect' registration additionally admits a socket slot
      // that is a UNION carrying a netSocket arm (the h2 compat
      // listener — the emitted adapter wraps the socket there).
      const cbT = e.args[1]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 3;
      if (ok && cbT?.kind === "func") {
        const [p0, p1, p2] = cbT.params;
        if (p0 !== undefined && p0.kind !== "httpReq") ok = false;
        if (p1 !== undefined && p1.kind !== "netSocket") {
          if (e.fn === "http.serverOnConnect" && p1?.kind === "union") {
            const def = unions.get(p1.unionId);
            if (!def || !def.arms.some((a) => a.kind === "netSocket")) ok = false;
          } else {
            ok = false;
          }
        }
        if (p2 !== undefined && !(p2.kind === "bytes" && p2.elem === "u8")) ok = false;
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "net.listenOptsCb" || e.fn === "net.listenOptsReusePortCb") {
      const cbIndex = e.fn === "net.listenOptsReusePortCb" ? 5 : 4;
      const t = e.args[cbIndex]?.type;
      const funcOk = (x: IrType | undefined): boolean =>
        x?.kind === "func" && x.params.length === 0 && x.ret.kind === "void";
      let ok = funcOk(t);
      if (!ok && t?.kind === "union") {
        const def = unions.get(t.unionId);
        ok =
          !!def &&
          def.arms.length === 2 &&
          def.arms.some((a) => funcOk(a)) &&
          def.arms.some((a) => a.kind === "undefinedT");
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "net.connectLookup") {
      // The caller's resolver: (hostname: string, options: unknown,
      // callback: (err: <union>, addresses: <record[]>) => void) =>
      // void — the emitter synthesizes the answer thunk from these
      // types, so the structure must hold.
      const t = e.args[2]?.type;
      let ok =
        t?.kind === "func" &&
        t.ret.kind === "void" &&
        t.params.length === 3 &&
        t.params[0]!.kind === "string" &&
        t.params[1]!.kind === "dyn";
      if (ok && t?.kind === "func") {
        const cbT = t.params[2]!;
        ok =
          cbT.kind === "func" &&
          cbT.ret.kind === "void" &&
          cbT.params.length === 2 &&
          cbT.params[0]!.kind === "union" &&
          cbT.params[1]!.kind === "array" &&
          cbT.params[1]!.elem.kind === "record";
      }
      if (!ok) {
        err(`libCall net.connectLookup resolver shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.requestConn" || e.fn === "http.requestConnCb") {
      const dialT = e.args[0]?.type;
      if (
        !(dialT?.kind === "func" && dialT.params.length === 0 && dialT.ret.kind === "netSocket")
      ) {
        err(`libCall ${e.fn} dialer shape (frontend must fence)`, e.loc);
        return true;
      }
      if (e.fn === "http.requestConnCb") {
        const cbT = e.args[6]?.type;
        const ok =
          cbT?.kind === "func" &&
          cbT.ret.kind === "void" &&
          cbT.params.length <= 1 &&
          (cbT.params[0] === undefined || cbT.params[0].kind === "httpReq");
        if (!ok) err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.reqStatusMessage" || e.fn === "http.resStatusMsgGet") {
      // Result is the interned `string | undefined` union (reqHeader's).
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "string") &&
        def.arms.some((a) => a.kind === "undefinedT");
      if (!ok) {
        err(`libCall ${e.fn} must return the 'string | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.resSocket") {
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "netSocket") &&
        def.arms.some((a) => a.kind === "nullT");
      if (!ok) err(`libCall http.resSocket must return the 'Socket | null' union`, e.loc);
      return true;
    }
    if (e.fn === "http.reqH2Stream") {
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "http2Stream") &&
        def.arms.some((a) => a.kind === "undefinedT");
      if (!ok)
        err(`libCall http.reqH2Stream must return the 'Http2Stream | undefined' union`, e.loc);
      return true;
    }
    if (
      e.fn === "http.reqHeader" ||
      e.fn === "http.reqTrailer" ||
      e.fn === "http.resGetHeader" ||
      e.fn === "http.clientGetHeader"
    ) {
      // Result is the interned `string | undefined` union (envGet's).
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "string" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall ${e.fn} must return the 'string | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "http.reqHeaderValues" || e.fn === "http.reqTrailerValues") {
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "array" &&
        def.arms[0]!.elem.kind === "string" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) err(`libCall ${e.fn} must return the 'string[] | undefined' union`, e.loc);
      return true;
    }
    if (
      e.fn === "net.createServerCb" ||
      e.fn === "net.serverOnConnection" ||
      e.fn === "net.serverOnSecureConnection" ||
      e.fn === "http.serverSetTimeoutCb" ||
      e.fn === "http.serverOnTimeout" ||
      e.fn === "http.clientOnSocket" ||
      e.fn === "net.sockOnData" ||
      e.fn === "net.serverOnError" ||
      e.fn === "net.sockOnError"
    ) {
      // The program-dependent listener shapes: a void closure with no
      // params, or exactly the one supported parameter per event
      // (socket handle / data chunk bytes / error %Error). The
      // callback slot is arg 0 for createServerCb, arg 1 otherwise.
      const cbT =
        e.args[e.fn === "net.createServerCb" ? 0 : e.fn === "http.serverSetTimeoutCb" ? 2 : 1]
          ?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        const p = cbT.params[0]!;
        if (e.fn === "net.sockOnData")
          ok = (p.kind === "bytes" && p.elem === "u8") || p.kind === "dyn";
        else if (e.fn === "net.serverOnError" || e.fn === "net.sockOnError") {
          ok = p.kind === "object" && p.className === "%Error";
        } else ok = p.kind === "netSocket";
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "http2.createSecureServerSni") {
      // The SNI callback: (servername: string, cb: (err, ctx?) => void)
      // => void — as a bare func, or the `| undefined` union from the
      // conditional-spread spelling (exactly two arms: the func and
      // undefined). The cb's own params are program-interned unions
      // (Error|null, SecureContext|undefined) whose arms the emitted
      // answer thunk decodes; here the structural func shape is what
      // the validator can pin.
      const sniOk = (t: IrType | undefined): boolean =>
        t?.kind === "func" &&
        t.ret.kind === "void" &&
        t.params.length === 2 &&
        t.params[0]!.kind === "string" &&
        t.params[1]!.kind === "func";
      const argT = e.args[2]?.type;
      let ok = sniOk(argT);
      if (!ok && argT?.kind === "union") {
        const def = unions.get(argT.unionId);
        ok =
          def !== undefined &&
          def.arms.length === 2 &&
          def.arms.some((a) => a.kind === "undefinedT") &&
          def.arms.some((a) => sniOk(a));
      }
      if (!ok) {
        err(`libCall ${e.fn} SNI callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "dgram.onMessage" || e.fn === "dgram.onError") {
      // The dgram listener shapes: a void closure with no params, or
      // the per-event parameter shapes — message takes (msg: bytes<u8>
      // [, rinfo: record]), error the one %Error param.
      const cbT = e.args[1]?.type;
      const maxParams = e.fn === "dgram.onMessage" ? 2 : 1;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= maxParams;
      if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
        if (e.fn === "dgram.onMessage") {
          const p0 = cbT.params[0]!;
          ok = p0.kind === "bytes" && p0.elem === "u8";
          const p1 = cbT.params[1];
          if (ok && p1 !== undefined) ok = p1.kind === "record";
        } else {
          const p = cbT.params[0]!;
          ok = p.kind === "object" && p.className === "%Error";
        }
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "dns.lookup") {
      // The callback: void, at most (err: Error | null, address:
      // string, family: number).
      const cbT = e.args[2]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 3;
      if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
        const p0 = cbT.params[0]!;
        const def = p0.kind === "union" ? unions.get(p0.unionId) : undefined;
        ok =
          def !== undefined &&
          def.arms.length === 2 &&
          def.arms.some((a) => a.kind === "nullT") &&
          def.arms.some((a) => a.kind === "object" && a.className === "%Error");
        const p1 = cbT.params[1];
        if (ok && p1 !== undefined) ok = p1.kind === "string";
        const p2 = cbT.params[2];
        if (ok && p2 !== undefined) ok = p2.kind === "f64";
      }
      if (!ok) {
        err(`libCall dns.lookup callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    return false;
  }

  function checkLibFileCall(e: IrExpr & { kind: "libCall" }): boolean {
    if (
      e.fn === "zlib.deflateCb" ||
      e.fn === "zlib.inflateCb" ||
      e.fn === "zlib.deflateRawCb" ||
      e.fn === "zlib.inflateRawCb" ||
      e.fn === "zlib.gzipCb" ||
      e.fn === "zlib.gunzipCb" ||
      e.fn === "zlib.unzipCb"
    ) {
      const cbT = e.args[1]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 2;
      if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
        const error = cbT.params[0]!;
        if (error.kind !== "dyn") {
          const def = error.kind === "union" ? unions.get(error.unionId) : undefined;
          ok =
            def !== undefined &&
            def.arms.some((arm) => arm.kind === "nullT") &&
            def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error") &&
            def.arms.every(
              (arm) =>
                arm.kind === "nullT" ||
                arm.kind === "undefinedT" ||
                (arm.kind === "object" && arm.className === "%Error"),
            );
        }
      }
      if (ok && cbT?.kind === "func" && cbT.params.length === 2) {
        const value = cbT.params[1]!;
        ok = value.kind === "dyn" || (value.kind === "bytes" && value.elem === "u8");
      }
      if (!ok) err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      return true;
    }
    if (
      e.fn === "fs.renameCb" ||
      e.fn === "process.stdoutWriteBytesCb" ||
      e.fn === "process.stderrWriteBytesCb"
    ) {
      // The callback is void and accepts either no parameters, one
      // checked-dynamic error slot (JS), or Error | null (optionally
      // including undefined for an explicitly optional parameter).
      const cbT = e.args[2]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        const p = cbT.params[0]!;
        if (p.kind === "dyn") {
          ok = true;
        } else {
          const def = p.kind === "union" ? unions.get(p.unionId) : undefined;
          ok =
            def !== undefined &&
            def.arms.some((a) => a.kind === "nullT") &&
            def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
            def.arms.every(
              (a) =>
                a.kind === "nullT" ||
                a.kind === "undefinedT" ||
                (a.kind === "object" && a.className === "%Error"),
            );
        }
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "net.serverAddress") {
      // Result is the {address, family, port} record (dgram.address's
      // check, another receiver).
      const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
      const ok =
        shape !== undefined &&
        shape.fields.length === 3 &&
        shape.fields[0]!.name === "address" &&
        shape.fields[0]!.type.kind === "string" &&
        shape.fields[1]!.name === "family" &&
        shape.fields[1]!.type.kind === "string" &&
        shape.fields[2]!.name === "port" &&
        shape.fields[2]!.type.kind === "f64";
      if (!ok) {
        err(`libCall net.serverAddress must return the {address, family, port} record`, e.loc);
      }
      return true;
    }
    if (e.fn === "dgram.address") {
      // Result is the {address, family, port} record.
      const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
      const ok =
        shape !== undefined &&
        shape.fields.length === 3 &&
        shape.fields[0]!.name === "address" &&
        shape.fields[0]!.type.kind === "string" &&
        shape.fields[1]!.name === "family" &&
        shape.fields[1]!.type.kind === "string" &&
        shape.fields[2]!.name === "port" &&
        shape.fields[2]!.type.kind === "f64";
      if (!ok) {
        err(`libCall dgram.address must return the {address, family, port} record`, e.loc);
      }
      return true;
    }
    if (e.fn === "fs.readdirTypesSync" || e.fn === "fsp.readdirTypes") {
      // Result: the interned Dirent record array — {%dtype: f64,
      // name: string, parentPath: string} rows (canonical field
      // order; the structure lowerFsReaddirTypesCall pinned).
      const result =
        e.fn === "fsp.readdirTypes"
          ? e.type.kind === "promise"
            ? e.type.inner
            : undefined
          : e.type;
      const shape =
        result?.kind === "array" && result.elem.kind === "record"
          ? records.get(result.elem.shapeId)
          : undefined;
      const ok =
        shape !== undefined &&
        !shape.tuple &&
        shape.indexValue === undefined &&
        shape.fields.length === 3 &&
        shape.fields[0]!.name === "%dtype" &&
        shape.fields[0]!.type.kind === "f64" &&
        shape.fields[1]!.name === "name" &&
        shape.fields[1]!.type.kind === "string" &&
        shape.fields[2]!.name === "parentPath" &&
        shape.fields[2]!.type.kind === "string";
      if (!ok) {
        err(
          `libCall ${e.fn} must return ${e.fn === "fsp.readdirTypes" ? "a promise of " : ""}the Dirent record array`,
          e.loc,
        );
      }
      return true;
    }
    if (e.fn === "os.networkInterfaces") {
      // Result: a pure index-signature record whose value is
      // `Info[] | undefined`, Info a two-record union (one arm's
      // scopeid f64, the other's `number | undefined`) — the structure
      // lowerOsNetworkInterfacesCall pinned.
      const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
      let ok =
        shape !== undefined &&
        !shape.tuple &&
        shape.fields.length === 0 &&
        shape.indexValue !== undefined;
      const ivDef =
        ok && shape!.indexValue!.kind === "union"
          ? unions.get(shape!.indexValue!.unionId)
          : undefined;
      const arrArm = ivDef?.arms.find((a) => a.kind === "array");
      ok =
        ok &&
        ivDef !== undefined &&
        ivDef.arms.length === 2 &&
        arrArm !== undefined &&
        ivDef.arms.some((a) => a.kind === "undefinedT");
      const infoDef =
        ok && arrArm!.kind === "array" && arrArm!.elem.kind === "union"
          ? unions.get(arrArm!.elem.unionId)
          : undefined;
      ok =
        ok &&
        infoDef !== undefined &&
        infoDef.arms.length === 2 &&
        infoDef.arms.every((a) => a.kind === "record");
      if (!ok) {
        err(
          `libCall os.networkInterfaces must return the NetworkInterfaceInfo dictionary record`,
          e.loc,
        );
      }
      return true;
    }
    if (e.fn === "qs.parse") {
      // Result: a pure index-signature record whose value union
      // carries a string arm and a string[] arm (undefined tolerated
      // — @types/node's Dict — and f64 too: the header-family
      // canonicalization interns every such dictionary with the
      // number arm, type-level only) — the structure
      // lowerQuerystringParseCall pinned.
      const shape = e.type.kind === "record" ? records.get(e.type.shapeId) : undefined;
      let ok =
        shape !== undefined &&
        !shape.tuple &&
        shape.fields.length === 0 &&
        shape.indexValue !== undefined;
      const ivDef =
        ok && shape!.indexValue!.kind === "union"
          ? unions.get(shape!.indexValue!.unionId)
          : undefined;
      ok =
        ok &&
        ivDef !== undefined &&
        ivDef.arms.some((a) => a.kind === "string") &&
        ivDef.arms.some((a) => a.kind === "array" && a.elem.kind === "string") &&
        ivDef.arms.every(
          (a) =>
            a.kind === "string" ||
            a.kind === "array" ||
            a.kind === "undefinedT" ||
            a.kind === "f64",
        );
      if (!ok) {
        err(`libCall qs.parse must return the ParsedUrlQuery dictionary record`, e.loc);
      }
      return true;
    }
    return false;
  }

  function checkLibProcessCall(e: IrExpr & { kind: "libCall" }): boolean {
    if (e.fn === "cp.execFile") {
      const cb = e.args[2]?.type;
      if (
        cb?.kind !== "func" ||
        cb.rest === true ||
        cb.params.length > 3 ||
        cb.ret.kind !== "void"
      ) {
        err(
          `libCall cp.execFile callback must be a non-rest void function with at most three parameters`,
          e.loc,
        );
      } else {
        const error = cb.params[0];
        if (error !== undefined) {
          const def = error.kind === "union" ? unions.get(error.unionId) : undefined;
          if (
            !def ||
            def.arms.length !== 2 ||
            !def.arms.some((arm) => arm.kind === "nullT") ||
            !def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error")
          ) {
            err(`libCall cp.execFile callback error parameter must be Error | null`, e.loc);
          }
        }
        const stdout = cb.params[1];
        if (stdout !== undefined && stdout.kind !== "string") {
          err(`libCall cp.execFile callback stdout parameter must be string`, e.loc);
        }
        const stderr = cb.params[2];
        if (stderr !== undefined && stderr.kind !== "string") {
          err(`libCall cp.execFile callback stderr parameter must be string`, e.loc);
        }
      }
    }
    if (e.fn === "child.onSpawn") {
      const cb = e.args[1];
      if (
        !cb ||
        cb.type.kind !== "func" ||
        cb.type.params.length !== 0 ||
        cb.type.ret.kind !== "void"
      )
        err("child.onSpawn callback must be () => void", e.loc);
    }
    if (e.fn === "child.onExit" || e.fn === "child.onClose" || e.fn === "child.onError") {
      // The listener: a closure with no params, or exactly the
      // supported parameter shapes per event — exit takes (code:
      // number | null) with an optional (signal: string | null)
      // second parameter, error exactly (err: %Error).
      const cb = e.args[1];
      const cbT = cb?.type;
      const maxParams = e.fn === "child.onError" ? 1 : 2;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= maxParams;
      if (ok && cbT?.kind === "func" && cbT.params.length >= 1) {
        const p = cbT.params[0]!;
        if (e.fn === "child.onExit" || e.fn === "child.onClose") {
          const def = p.kind === "union" ? unions.get(p.unionId) : undefined;
          ok =
            def !== undefined &&
            def.arms.length === 2 &&
            def.arms[0]!.kind === "f64" &&
            def.arms[1]!.kind === "nullT";
          if (ok && cbT.params.length === 2) {
            const s = cbT.params[1]!;
            const sdef = s.kind === "union" ? unions.get(s.unionId) : undefined;
            ok =
              sdef !== undefined &&
              sdef.arms.length === 2 &&
              sdef.arms.some((a) => a.kind === "string") &&
              sdef.arms.some((a) => a.kind === "nullT");
          }
        } else {
          ok = p.kind === "object" && p.className === "%Error";
        }
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "writer.onDrain" || e.fn === "writer.onFinish" || e.fn === "writer.onError") {
      const cbT = e.args[1]?.type;
      const maxParams = e.fn === "writer.onError" ? 1 : 0;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= maxParams;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        const p = cbT.params[0]!;
        ok = p.kind === "object" && p.className === "%Error";
      }
      if (!ok) err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      return true;
    }
    if (
      e.fn === "process.onExit" ||
      e.fn === "process.offExit" ||
      e.fn === "stdin.onData" ||
      e.fn === "stdin.onError"
    ) {
      // The listener: a void closure with no params, or exactly the
      // one supported parameter shape per event (code number / data
      // chunk bytes / error %Error).
      const cbT = e.args[0]?.type;
      let ok = cbT?.kind === "func" && cbT.ret.kind === "void" && cbT.params.length <= 1;
      if (ok && cbT?.kind === "func" && cbT.params.length === 1) {
        const p = cbT.params[0]!;
        if (e.fn === "stdin.onData") ok = p.kind === "bytes" && p.elem === "u8";
        else if (e.fn === "stdin.onError") ok = p.kind === "object" && p.className === "%Error";
        else ok = p.kind === "f64";
      }
      if (!ok) {
        err(`libCall ${e.fn} callback shape (frontend must fence)`, e.loc);
      }
      return true;
    }
    if (e.fn === "spawnRes.status") {
      // Result is the module's interned `number | null` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "f64" &&
        def.arms[1]!.kind === "nullT";
      if (!ok) {
        err(`libCall spawnRes.status must return the 'number | null' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "spawnRes.signal") {
      // Result is the module's interned `string | null` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "string") &&
        def.arms.some((a) => a.kind === "nullT");
      if (!ok) {
        err(`libCall spawnRes.signal must return the 'string | null' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "sp.get") {
      // Result is the interned `string | null` union (the runtime
      // answers +1-or-NULL; the backend builds the arms).
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "string") &&
        def.arms.some((a) => a.kind === "nullT");
      if (!ok) {
        err(`libCall sp.get must return the 'string | null' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "sp.fromPairs") {
      const t = e.args[0]?.type;
      const ok =
        t && t.kind === "array" && t.elem.kind === "array" && t.elem.elem.kind === "string";
      if (!ok) {
        err(`libCall sp.fromPairs arg 0: expected string[][], got ${t?.kind}`, e.loc);
      }
      return true;
    }
    if (e.fn === "sym.desc" || e.fn === "sym.keyFor") {
      // Result is the interned `string | undefined` union (the
      // runtime answers +1-or-NULL; the backend builds the arms).
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "string") &&
        def.arms.some((a) => a.kind === "undefinedT");
      if (!ok) {
        err(`libCall ${e.fn} must return the 'string | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "spawnRes.error") {
      // Result is the interned `%Error | undefined` union.
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
        def.arms.some((a) => a.kind === "undefinedT");
      if (!ok) {
        err(`libCall spawnRes.error must return the 'Error | undefined' union`, e.loc);
      }
      return true;
    }
    if (e.fn === "child.pid" || e.fn === "child.exitCode") {
      // pid: the interned `number | undefined`; exitCode: `number | null`.
      const wantUnit = e.fn === "child.pid" ? "undefinedT" : "nullT";
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "f64" &&
        def.arms[1]!.kind === wantUnit;
      if (!ok) {
        err(
          `libCall ${e.fn} must return the 'number | ${wantUnit === "nullT" ? "null" : "undefined"}' union`,
          e.loc,
        );
      }
      return true;
    }
    if (e.fn === "net.serverCloseBind") {
      // The bound close: (cbUnion) => netServer, cbUnion carrying a
      // void-returning func arm (≤1 param) and the undefined arm.
      const t = e.type;
      const cbU = t.kind === "func" && t.params.length === 1 ? t.params[0]! : null;
      const def = cbU?.kind === "union" ? unions.get(cbU.unionId) : undefined;
      const ok =
        t.kind === "func" &&
        (t.ret.kind === "netServer" || t.ret.kind === "void") &&
        def &&
        def.arms.some((a) => a.kind === "func" && a.params.length <= 1 && a.ret.kind === "void") &&
        def.arms.some((a) => a.kind === "undefinedT");
      if (!ok) {
        err(`libCall net.serverCloseBind must produce the bound-close func type`, e.loc);
      }
      return true;
    }
    if (e.fn === "child.stdin" || e.fn === "child.stdout" || e.fn === "child.stderr") {
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const handleKind = e.fn === "child.stdin" ? "childWriter" : "childStream";
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === handleKind) &&
        def.arms.some((a) => a.kind === "nullT");
      if (!ok) {
        err(
          `libCall ${e.fn} must return the '${e.fn === "child.stdin" ? "Writable" : "Readable"} | null' union`,
          e.loc,
        );
      }
      return true;
    }
    return false;
  }

  function checkLibSpecialCall(e: IrExpr & { kind: "libCall" }): boolean {
    if (e.fn === "island.castFail") {
      // The deferred boundary failure's typed dummy: a promise (the
      // only cast shape the frontend defers).
      if (e.type.kind !== "promise") {
        err(`libCall island.castFail must return a promise type, got ${e.type.kind}`, e.loc);
      }
      return true;
    }
    if (e.fn === "global.undefRead") {
      // Always throws — the result type is whatever the declared type
      // of the undefined global mapped to (never materialized).
      return true;
    }
    if (
      e.fn === "error.nodeThrow" ||
      e.fn === "error.argTypeThrow" ||
      e.fn === "error.propTypeThrow" ||
      e.fn === "fs.mkdtempChk" ||
      e.fn === "fs.readFileChk" ||
      e.fn === "fs.opendirChk" ||
      e.fn === "fs.watchFileChk" ||
      e.fn === "fs.lchmodChk" ||
      e.fn === "fs.readChk" ||
      e.fn === "fs.streamOptsChk" ||
      e.fn === "net.connectOptsChk" ||
      e.fn === "tls.caCertsChk"
    ) {
      // Always throws — the result type is the replaced expression's
      // own (never materialized; the global.undefRead pattern). The
      // fs Chk ladders qualify: every validation failure throws
      // Node's typed error, and a full pass throws the trailing
      // compiler-rendered fence.
      return true;
    }
    if (e.fn === "error.new" || e.fn === "error.newOptions") {
      // Which builtin the runtime constructs is named by the result type.
      if (!isBuiltinErrorObject(e.type)) {
        err(`libCall ${e.fn} must return a builtin error class, got ${e.type.kind}`, e.loc);
      }
      return true;
    }
    if (e.fn === "error.newDom") {
      if (e.type.kind !== "object" || e.type.className !== "%DOMException") {
        err(`libCall error.newDom must return %DOMException, got ${e.type.kind}`, e.loc);
      }
      return true;
    }
    if (
      e.fn === "error.domCode" ||
      e.fn === "error.domHasCause" ||
      e.fn === "error.domCause" ||
      e.fn === "error.domClone"
    ) {
      // Receiver: exactly %DOMException (subclassing is fenced — the
      // hidden runtime slots admit no other layout).
      const recv = e.args[0];
      if (!recv || recv.type.kind !== "object" || recv.type.className !== "%DOMException") {
        err(`libCall ${e.fn} receiver must be %DOMException`, e.loc);
      }
      return true;
    }
    if (e.fn === "class.name") {
      // The arg is any class value (program-dependent classval).
      if (e.args[0]?.type.kind !== "classval") {
        err(`libCall class.name takes a class value`, e.loc);
      }
      if (e.type.kind !== "string") {
        err(`libCall class.name must return string`, e.loc);
      }
      return true;
    }
    if (e.fn === "assert.refEqBytes" || e.fn === "assert.bytesDeepEq") {
      // Both value slots: ONE static bytes type (the frontend's
      // same-static-type gate — a u8/u32 mix would memcmp garbage).
      const a = e.args[0]?.type;
      const b = e.args[1]?.type;
      if (a?.kind !== "bytes" || b === undefined || !typeEquals(a, b)) {
        err(`libCall ${e.fn} takes two same-typed bytes values`, e.loc);
      }
      return true;
    }
    if (e.fn === "assert.refEqFn") {
      // ANY two function signatures: the compare is pointer identity.
      if (e.args[0]?.type.kind !== "func" || e.args[1]?.type.kind !== "func") {
        err(`libCall assert.refEqFn takes two function values`, e.loc);
      }
      return true;
    }
    if (e.fn === "error.code") {
      // Receiver: any error-hierarchy object (a user subclass embeds
      // the code slot in its prefix); result: the interned
      // `string | undefined` union (the process.envGet pattern).
      const recv = e.args[0];
      if (!recv || recv.type.kind !== "object") {
        err(`libCall error.code receiver must be an error object`, e.loc);
        return true;
      }
      const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
      const ok =
        def &&
        def.arms.length === 2 &&
        def.arms[0]!.kind === "string" &&
        def.arms[1]!.kind === "undefinedT";
      if (!ok) {
        err(`libCall error.code must return the 'string | undefined' union`, e.loc);
      }
      return true;
    }
    return false;
  }

  function checkLibStreamCall(
    e: IrExpr & { kind: "libCall" },
    fixedArgs: number,
    result: IrType,
  ): boolean {
    if (
      e.fn.startsWith("readable.") ||
      e.fn.startsWith("writable.") ||
      e.fn.startsWith("duplex.") ||
      e.fn.startsWith("transform.") ||
      e.fn.startsWith("passthrough.") ||
      e.fn === "stream.destroy" ||
      e.fn === "stream.destroyErr" ||
      e.fn === "stream.iteratorClose" ||
      e.fn === "stream.prop" ||
      e.fn === "stream.errored" ||
      e.fn === "stream.finished" ||
      e.fn === "stream.finishedDyn" ||
      e.fn === "stream.pipeline" ||
      e.fn === "stream.pipelineDyn"
    ) {
      // Receiver/result: stream-hierarchy objects (a class whose base
      // chain reaches a runtime stream class). Constructors have no
      // receiver — their RESULT names the class; chaining forms
      // return the receiver's static type; pipe returns its
      // destination's.
      const isStreamObject = (t: IrType | undefined): boolean => {
        if (t?.kind !== "object") return false;
        let name: string | undefined = t.className;
        while (name !== undefined) {
          if (RUNTIME_STREAM_CLASSES.has(name)) return true;
          name = classes.get(name)?.base;
        }
        return false;
      };
      if (e.fn.endsWith(".new")) {
        if (!isStreamObject(e.type)) {
          err(`libCall ${e.fn} must return a stream class, got ${e.type.kind}`, e.loc);
        }
        for (let i = fixedArgs; i < e.args.length; i++) {
          if (e.args[i]!.type.kind !== "func") {
            err(`libCall ${e.fn} option callback ${i} must be a func`, e.loc);
          }
        }
        return true;
      }
      if (e.fn.endsWith(".newDyn")) {
        // The dyn-options constructor: (optsDyn) → the stream class.
        if (!isStreamObject(e.type)) {
          err(`libCall ${e.fn} must return a stream class, got ${e.type.kind}`, e.loc);
        }
        return true;
      }
      if (e.fn.endsWith(".initDyn")) {
        // (recv, optsDyn, flags, ...fallback wrapper closures).
        if (!isStreamObject(e.args[0]?.type)) {
          err(`libCall ${e.fn} receiver must be a stream-hierarchy object`, e.loc);
        }
        for (let i = fixedArgs; i < e.args.length; i++) {
          if (e.args[i]!.type.kind !== "func") {
            err(`libCall ${e.fn} fallback callback ${i} must be a func`, e.loc);
          }
        }
        if (e.type.kind !== "void") err(`libCall ${e.fn} must be void`, e.loc);
        return true;
      }
      if (e.fn === "stream.finished" || e.fn === "stream.finishedDyn") {
        // (recv, cb) → the cleanup closure.
        if (!isStreamObject(e.args[0]?.type)) {
          err(`libCall ${e.fn} receiver must be a stream-hierarchy object`, e.loc);
        }
        const cbK = e.args[1]?.type.kind;
        if (e.fn === "stream.finished" ? cbK !== "func" : cbK !== "dyn") {
          err(
            `libCall ${e.fn} callback must be ${e.fn === "stream.finished" ? "a func" : "dyn"}`,
            e.loc,
          );
        }
        if (e.type.kind !== "func") {
          err(`libCall ${e.fn} must return the cleanup closure, got ${e.type.kind}`, e.loc);
        }
        return true;
      }
      if (e.fn === "stream.pipeline" || e.fn === "stream.pipelineDyn") {
        // (count, s1..sn, cb) → the destination's type.
        const count = e.args[0];
        const n = count?.kind === "numLit" ? count.value : -1;
        if (n < 2 || e.args.length !== n + 2) {
          err(`libCall ${e.fn} count/arity mismatch`, e.loc);
          return true;
        }
        for (let i = 1; i <= n; i++) {
          if (!isStreamObject(e.args[i]?.type)) {
            err(`libCall ${e.fn} stage ${i} must be a stream-hierarchy object`, e.loc);
          }
        }
        const cbK = e.args[n + 1]?.type.kind;
        if (e.fn === "stream.pipeline" ? cbK !== "func" : cbK !== "dyn") {
          err(
            `libCall ${e.fn} callback must be ${e.fn === "stream.pipeline" ? "a func" : "dyn"}`,
            e.loc,
          );
        }
        if (!typeEquals(e.type, e.args[n]!.type)) {
          err(`libCall ${e.fn} must return its destination's type`, e.loc);
        }
        return true;
      }
      if (e.fn === "readable.fromArr") {
        // No receiver: the seed array leads; the result is the class.
        if (e.args[0]?.type.kind !== "array" || !isStreamObject(e.type)) {
          err(`libCall readable.fromArr must take an array and return a stream class`, e.loc);
        }
        return true;
      }
      if (!isStreamObject(e.args[0]?.type)) {
        err(`libCall ${e.fn} receiver must be a stream-hierarchy object`, e.loc);
        return true;
      }
      if (e.fn === "readable.nextChunk" || e.fn === "readable.nextChunkDyn") {
        if (e.type.kind !== "promise") {
          err(`libCall ${e.fn} must return a promise, got ${e.type.kind}`, e.loc);
        }
        return true;
      }
      if (
        e.fn === "readable.pause" ||
        e.fn === "readable.resume" ||
        e.fn === "readable.unpipe" ||
        e.fn === "writable.end" ||
        e.fn === "readable.setEncoding" ||
        e.fn === "readable.pushEncoding" ||
        e.fn === "stream.destroy" ||
        e.fn === "stream.destroyErr" ||
        e.fn === "stream.iteratorClose"
      ) {
        if (!typeEquals(e.type, e.args[0]!.type)) {
          err(`libCall ${e.fn} must return its receiver's type (the chaining 'this')`, e.loc);
        }
        return true;
      }
      if (e.fn === "readable.pipe") {
        if (!isStreamObject(e.args[1]?.type) || !typeEquals(e.type, e.args[1]!.type)) {
          err(`libCall readable.pipe must return its destination's type`, e.loc);
        }
        return true;
      }
      if (e.fn === "readable.read" || e.fn === "readable.flowing" || e.fn === "stream.errored") {
        const def = e.type.kind === "union" ? unions.get(e.type.unionId) : undefined;
        const wantArm = (t: IrType): boolean =>
          e.fn === "readable.read"
            ? t.kind === "bytes"
            : e.fn === "readable.flowing"
              ? t.kind === "bool"
              : t.kind === "object";
        const ok =
          def &&
          def.arms.length === 2 &&
          def.arms.some(wantArm) &&
          def.arms.some((a) => a.kind === "nullT");
        if (!ok) err(`libCall ${e.fn} must return its nullable union`, e.loc);
        return true;
      }
      if (e.fn === "stream.prop") {
        if (e.type.kind !== "bool" && e.type.kind !== "f64") {
          err(`libCall stream.prop must be bool or f64, got ${e.type.kind}`, e.loc);
        }
        return true;
      }
      if (!typeEquals(e.type, result)) {
        err(`libCall ${e.fn} must be ${result.kind}, got ${e.type.kind}`, e.loc);
      }
      return true;
    }
    return false;
  }

  function checkLibEmitterCall(e: IrExpr & { kind: "libCall" }, result: IrType): boolean {
    if (
      (e.fn.startsWith("emitter.") || e.fn === "stream.onDyn") &&
      e.fn !== "emitter.setDefaultMax" &&
      e.fn !== "emitter.setDefaultMaxChk" &&
      e.fn !== "emitter.getDefaultMax" &&
      e.fn !== "emitter.checkListener"
    ) {
      // Receiver: an emitter-hierarchy object (the %EventEmitter class
      // itself, or a class whose base chain reaches it). emitter.new
      // has no receiver — its RESULT is the bare emitter class.
      const isEmitterObject = (t: IrType | undefined): boolean => {
        if (t?.kind !== "object") return false;
        let name: string | undefined = t.className;
        while (name !== undefined) {
          if (name === RUNTIME_EMITTER_CLASS) return true;
          name = classes.get(name)?.base;
        }
        return false;
      };
      if (e.fn === "emitter.new") {
        if (e.type.kind !== "object" || e.type.className !== RUNTIME_EMITTER_CLASS) {
          err(`libCall emitter.new must return '%EventEmitter', got ${e.type.kind}`, e.loc);
        }
        return true;
      }
      if (!isEmitterObject(e.args[0]?.type)) {
        err(`libCall ${e.fn} receiver must be an emitter-hierarchy object`, e.loc);
        return true;
      }
      // The chaining forms return the receiver's own static class.
      if (
        e.fn === "emitter.on" ||
        e.fn === "emitter.off" ||
        e.fn === "emitter.onDyn" ||
        e.fn === "emitter.onFlex" ||
        e.fn === "stream.onDyn" ||
        e.fn === "emitter.offDyn" ||
        e.fn === "emitter.onData" ||
        e.fn === "emitter.onDataDyn" ||
        e.fn === "emitter.removeAll" ||
        e.fn === "emitter.setMax" ||
        e.fn === "emitter.setMaxChk"
      ) {
        if (!typeEquals(e.type, e.args[0]!.type)) {
          err(`libCall ${e.fn} must return its receiver's type (the chaining 'this')`, e.loc);
        }
        // The listener slots carry closures (the dyn family's checked-
        // dynamic listener is table-checked; its adapter is a func).
        if (
          (e.fn === "emitter.on" || e.fn === "emitter.off" || e.fn === "emitter.onData") &&
          e.args[2]?.type.kind !== "func"
        ) {
          err(`libCall ${e.fn} listener must be a func`, e.loc);
        }
        if (
          (e.fn === "emitter.onDyn" || e.fn === "emitter.onDataDyn") &&
          e.args[3]?.type.kind !== "func"
        ) {
          err(`libCall ${e.fn} adapter must be a func`, e.loc);
        }
        return true;
      }
      if (e.fn === "emitter.emitData") {
        const chunkT = e.args[2]?.type;
        const ok =
          chunkT !== undefined &&
          ((chunkT.kind === "bytes" && chunkT.elem === "u8") || chunkT.kind === "string");
        if (!ok) err(`libCall emitter.emitData chunk must be bytes<u8> or string`, e.loc);
        if (e.type.kind !== "bool") err(`libCall emitter.emitData must be bool`, e.loc);
        return true;
      }
      if (e.fn === "emitter.countFn" && e.args[2]?.type.kind !== "func") {
        err(`libCall emitter.countFn listener must be a func`, e.loc);
        return true;
      }
      if (e.fn === "emitter.emitError" && e.args[2]?.type.kind !== "object") {
        err(`libCall emitter.emitError payload must be an error-hierarchy object`, e.loc);
        return true;
      }
      if (e.fn === "emitter.names") {
        const ok = e.type.kind === "array" && e.type.elem.kind === "string";
        if (!ok) err(`libCall emitter.names must return string[]`, e.loc);
        return true;
      }
      if (e.fn === "emitter.listeners") {
        const ok = e.type.kind === "array" && e.type.elem.kind === "func";
        if (!ok) err(`libCall emitter.listeners must return a func array`, e.loc);
        return true;
      }
      if (e.fn === "emitter.emitFlex") {
        if (e.args.slice(2).some((arg) => arg.type.kind !== "dyn")) {
          err("libCall emitter.emitFlex payloads must be checked-dynamic", e.loc);
        }
      }
      if (
        e.fn === "emitter.emit" ||
        e.fn === "emitter.emitFlex" ||
        e.fn === "emitter.count" ||
        e.fn === "emitter.getMax" ||
        e.fn === "emitter.ctor" ||
        e.fn === "emitter.countFn" ||
        e.fn === "emitter.countDyn" ||
        e.fn === "emitter.emitError"
      ) {
        if (!typeEquals(e.type, result)) {
          err(`libCall ${e.fn} must be ${result.kind}, got ${e.type.kind}`, e.loc);
        }
        return true;
      }
    }
    return false;
  }

  function checkConversionExpr(e: IrExpr & { kind: "jsonStringify" | "dynCheck" }): void {
    switch (e.kind) {
      case "jsonStringify": {
        checkExpr(e.value);
        if (e.type.kind !== "string") {
          err(`jsonStringify must be string, got ${e.type.kind}`, e.loc);
        }
        // The value's STATIC type drives the emitted serializer — it must be
        // JSON-safe (the frontend rejects the rest with a specific message).
        // A dyn ROOT is the one non-static shape allowed: the runtime's dyn
        // walker serializes it (scr_dyn_format_j), no emitted serializer.
        if (
          e.value.type.kind !== "dyn" &&
          !isJsonStringifySafeType(
            e.value.type,
            (id) => records.get(id),
            (id) => unions.get(id),
          )
        ) {
          err(`jsonStringify of non-JSON-safe type ${e.value.type.kind}`, e.loc);
        }
        break;
      }
      case "dynCheck": {
        checkExpr(e.value);
        expectType(e.value, DYN, "dynCheck operand");
        // The target drives the emitted validator/builder: non-dyn,
        // non-void, JSON-representable (closures/class instances can never
        // be found inside a JSON dyn — the frontend rejects those casts).
        // Bare undefined-armed unions of JSON-safe arms are additionally
        // valid: the checked-dynamic tree holds a first-class undefined value (overflow
        // reads), which matches exactly the undefined arm.
        const jsonOk = (t: IrType): boolean =>
          isJsonSafeType(
            t,
            (id) => records.get(id),
            (id) => unions.get(id),
          );
        const undefArmedOk =
          e.type.kind === "union" &&
          (unions
            .get(e.type.unionId)
            ?.arms.every(
              (a) =>
                a.kind === "undefinedT" ||
                jsonOk(a) ||
                isDynTypedRefType(a) ||
                DYN_HANDLE_KINDS.has(a.kind),
            ) ??
            false);
        // bytes<u8> targets extract the checked-dynamic tree's bytes kind (a copy).
        const bytesOk = e.type.kind === "bytes" && e.type.elem === "u8";
        // The %Error root extracts the checked-dynamic tree's error encoding (the "%error"
        // marker object caughtToDyn builds) as a fresh runtime error.
        const errorOk = e.type.kind === "object" && e.type.className === "%Error";
        const classOk = isDynTypedRefType(e.type);
        // ADAPTABLE function targets unwrap or wrap the checked-dynamic tree's function
        // kind (the checked-dynamic function boundary, ir.ts).
        const funcOk =
          e.type.kind === "func" &&
          canAdaptDynFuncTo(
            e.type,
            (id) => records.get(id),
            (id) => unions.get(id),
          );
        // Runtime HANDLE targets unwrap the checked-dynamic tree's handle kind by tag (a
        // retained reference, no copy — DYN_HANDLE_KINDS).
        const handleOk = DYN_HANDLE_KINDS.has(e.type.kind);
        if (
          !canDynCheckTo(
            e.type,
            (id) => records.get(id),
            (id) => unions.get(id),
          ) &&
          !undefArmedOk &&
          !bytesOk &&
          !errorOk &&
          !classOk &&
          !funcOk &&
          !handleOk
        ) {
          err(`dynCheck against non-JSON-representable type ${e.type.kind}`, e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkAsyncExpr(
    e: IrExpr & {
      kind:
        | "awaitExpr"
        | "yieldExpr"
        | "genResume"
        | "awaitUnionExpr"
        | "newPromise"
        | "promiseWithResolvers";
    },
  ): void {
    switch (e.kind) {
      case "awaitExpr": {
        checkExpr(e.value);
        if (e.value.type.kind !== "promise") {
          err(`await of non-promise ${e.value.type.kind}`, e.loc);
        } else if (!typeEquals(e.type, e.value.type.inner)) {
          err(`await type ${e.type.kind} != promise inner ${e.value.type.inner.kind}`, e.loc);
        }
        if (!fn.async) err("await outside an async function", e.loc);
        break;
      }
      case "yieldExpr": {
        if (fn.generator === undefined) {
          err("yield outside a generator function", e.loc);
          break;
        }
        if (e.value === null) {
          err("yieldExpr with no operand (the frontend fills undefined)", e.loc);
          break;
        }
        checkExpr(e.value);
        if (!typeEquals(e.value.type, fn.generator.yieldT)) {
          err(
            `yield operand ${typeKey(e.value.type)} != yield channel ${typeKey(fn.generator.yieldT)}`,
            e.loc,
          );
        }
        // The undefined next-channel has no C value form: such yields are
        // void-typed (statement position only — the frontend fences reads).
        if (e.captureCompletion) {
          if (
            fn.async ||
            e.type.kind !== "dyn" ||
            !typeEquals(e.captureCompletion.returnType, fn.returnType)
          ) {
            err("invalid captured generator completion", e.loc);
          }
        } else if (fn.generator.nextT.kind === "undefinedT") {
          if (e.type.kind !== "void")
            err("yield result must be void on an undefined next-channel", e.loc);
        } else if (!typeEquals(e.type, fn.generator.nextT)) {
          err(
            `yield result ${typeKey(e.type)} != next channel ${typeKey(fn.generator.nextT)}`,
            e.loc,
          );
        }
        break;
      }
      case "genResume": {
        checkExpr(e.gen);
        if (e.gen.type.kind !== "generator") {
          err(`genResume on ${e.gen.type.kind}`, e.loc);
          break;
        }
        const genT = e.gen.type;
        if (e.arg !== null) checkExpr(e.arg);
        if (e.mode === "next") {
          if (e.arg === null) {
            if (genT.nextT.kind !== "undefinedT" && genT.nextT.kind !== "dyn") {
              err(`valueless next() on a ${typeKey(genT.nextT)} next-channel`, e.loc);
            }
          } else if (!typeEquals(e.arg.type, genT.nextT)) {
            err(
              `next argument ${typeKey(e.arg.type)} != next channel ${typeKey(genT.nextT)}`,
              e.loc,
            );
          }
        } else if (e.mode === "return") {
          if (e.arg !== null && !typeEquals(e.arg.type, genT.retT)) {
            err(
              `return argument ${typeKey(e.arg.type)} != return channel ${typeKey(genT.retT)}`,
              e.loc,
            );
          }
        } else {
          // throw: any exception-representable payload (the throw
          // statement's rule). Date cannot retain its object kind in the
          // untyped exception cell.
          if (e.arg === null) {
            err("genResume throw with no payload", e.loc);
          } else if (
            e.arg.type.kind === "void" ||
            e.arg.type.kind === "caught" ||
            e.arg.type.kind === "date"
          ) {
            err(`genResume throw of a ${e.arg.type.kind} value`, e.loc);
          }
        }
        // Sync resumes return IteratorResult directly; async resumes return
        // Promise<IteratorResult>. The record is { done: bool, value: V }
        // with V dyn (the any/unknown channel) or an undefined-armed union.
        const resultT = genT.async ? (e.type.kind === "promise" ? e.type.inner : null) : e.type;
        if (resultT?.kind !== "record") {
          err(
            `genResume result is ${typeKey(e.type)}, not ${genT.async ? "a promise of " : ""}a record`,
            e.loc,
          );
          break;
        }
        const rec = records.get(resultT.shapeId);
        const doneF = rec ? recordValidation.get(rec.id)?.fields.get("done") : undefined;
        const valueF = rec ? recordValidation.get(rec.id)?.fields.get("value") : undefined;
        if (!rec || rec.fields.length !== 2 || doneF?.kind !== "bool" || valueF === undefined) {
          err(`genResume result record ${resultT.shapeId} is not { done: bool, value: V }`, e.loc);
          break;
        }
        if (valueF.kind === "dyn") break;
        const vdef = valueF.kind === "union" ? unions.get(valueF.unionId) : undefined;
        if (!vdef || !vdef.arms.some((a) => a.kind === "undefinedT")) {
          err(
            `genResume value slot ${typeKey(valueF)} is neither dyn nor an undefined-armed union`,
            e.loc,
          );
        }
        break;
      }
      case "awaitUnionExpr": {
        checkExpr(e.value);
        const def = e.value.type.kind === "union" ? unions.get(e.value.type.unionId) : undefined;
        const promiseArm = def?.arms[e.promiseTag];
        if (!def) {
          err(`awaitUnion of non-union ${e.value.type.kind}`, e.loc);
        } else if (promiseArm?.kind !== "promise") {
          err(`awaitUnion arm ${e.promiseTag} is not a promise`, e.loc);
        } else if (!def.arms.every((a, i) => i === e.promiseTag || isUnitType(a))) {
          err("awaitUnion union has non-unit arms beside the promise", e.loc);
        } else if (e.type.kind === "void") {
          if (promiseArm.inner.kind !== "void") {
            err("awaitUnion void result over a value-carrying promise", e.loc);
          }
        } else if (e.type.kind !== "union") {
          err(`awaitUnion result is ${e.type.kind}, not void or a union`, e.loc);
        } else {
          const res = unions.get(e.type.unionId);
          const covered =
            res &&
            res.arms.some((a) => typeEquals(a, promiseArm.inner)) &&
            def.arms.every((a, i) => i === e.promiseTag || res.arms.some((b) => typeEquals(a, b)));
          if (!covered) err("awaitUnion result union misses an arm", e.loc);
        }
        if (!fn.async) err("await outside an async function", e.loc);
        break;
      }
      case "newPromise": {
        checkExpr(e.executor);
        if (e.type.kind !== "promise") {
          err("newPromise must have promise type", e.loc);
          break;
        }
        const inner = e.type.inner;
        const exec = e.executor.type;
        if (exec.kind !== "func" || exec.params.length > 2) {
          err("newPromise executor must be (resolve?, reject?) => void", e.loc);
          break;
        }
        if (exec.params.length === 2) {
          // The reject closure's one shape: (reason: %Error) => void.
          const rj = exec.params[1]!;
          if (
            rj.kind !== "func" ||
            rj.ret.kind !== "void" ||
            rj.params.length !== 1 ||
            rj.params[0]!.kind !== "object" ||
            rj.params[0]!.className !== "%Error"
          ) {
            err("newPromise reject param must be (%Error) => void", e.loc);
          }
        }
        if (exec.params.length >= 1) {
          const rp = exec.params[0]!;
          if (rp.kind !== "func" || rp.ret.kind !== "void") {
            err("newPromise resolve must be a void-returning function", e.loc);
            break;
          }
          const expectsArg = inner.kind !== "void";
          if (expectsArg && (rp.params.length !== 1 || !typeEquals(rp.params[0]!, inner))) {
            err(`newPromise resolve param must be (${inner.kind}) => void`, e.loc);
          }
          if (!expectsArg && rp.params.length !== 0) {
            err("newPromise<void> resolve takes no argument", e.loc);
          }
        }
        break;
      }
      case "promiseWithResolvers": {
        // The record shape: promise: Promise<T>, resolve: (T) => void
        // (() => void when T is void), reject: (%Error) => void.
        if (e.type.kind !== "record") {
          err("promiseWithResolvers must have record type", e.loc);
          break;
        }
        const shape = records.get(e.type.shapeId);
        const fields = recordValidation.get(e.type.shapeId)?.initializationFields;
        const prom = fields?.get("promise");
        const resolve = fields?.get("resolve");
        const reject = fields?.get("reject");
        if (!shape || shape.fields.length !== 3 || !prom || !resolve || !reject) {
          err("promiseWithResolvers record must be { promise, resolve, reject }", e.loc);
          break;
        }
        if (prom.kind !== "promise") {
          err("promiseWithResolvers promise field must be a promise", e.loc);
          break;
        }
        const inner = prom.inner;
        if (resolve.kind !== "func" || resolve.ret.kind !== "void") {
          err("promiseWithResolvers resolve must be a void-returning function", e.loc);
        } else if (
          inner.kind === "void"
            ? resolve.params.length !== 0
            : resolve.params.length !== 1 || !typeEquals(resolve.params[0]!, inner)
        ) {
          err(`promiseWithResolvers resolve param must match the promise's inner type`, e.loc);
        }
        if (
          reject.kind !== "func" ||
          reject.ret.kind !== "void" ||
          reject.params.length !== 1 ||
          reject.params[0]!.kind !== "object" ||
          reject.params[0]!.className !== "%Error"
        ) {
          err("promiseWithResolvers reject must be (%Error) => void", e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  function checkIslandExpr(
    e: IrExpr & { kind: "jsMarshal" | "jsOp" | "jsExit" | "jsBridgePromise" },
  ): void {
    switch (e.kind) {
      case "jsMarshal": {
        checkExpr(e.value);
        if (e.type.kind !== "jsval") err(`jsMarshal must be jsval, got ${e.type.kind}`, e.loc);
        const src = e.value.type;
        // The marshal direction admits qualifying closures (host-function
        // wrapping) on top of the JSON-safe set; jsExit does not. Typed
        // closures (per-param call-time conversion through the exit
        // machinery) are the wider func shape.
        // Typed arrays and URLs marshal IN (an engine typed-array copy /
        // an engine URL built from the components) without ever joining
        // the round-trip (JSON) set — the frontend's union lift narrows
        // union arms before marshaling, so bare bytes/url operands are
        // exactly what it produces.
        if (
          src.kind !== "bytes" &&
          src.kind !== "url" &&
          src.kind !== "dyn" && // dyn values deep-copy in (data kinds; the runtime throws on boxes)
          // A STATIC promise crosses as a real engine thenable when its
          // fulfillment is in the reverse bridge's payload domain
          // (scr_jsval_from_promise — the async-callback return bridge).
          !(src.kind === "promise" && islandPromisePayloadTag(src.inner) !== null) &&
          !canMarshalIntoIsland(
            src,
            (id) => records.get(id),
            (id) => unions.get(id),
          ) &&
          !canMarshalTypedFuncIntoIsland(
            src,
            (id) => records.get(id),
            (id) => unions.get(id),
          )
        ) {
          err(`jsMarshal of unmarshalable type ${src.kind}`, e.loc);
        }
        break;
      }
      case "jsOp": {
        for (const a of e.args) checkExpr(a);
        if (e.type.kind !== jsOpResultKind(e.op)) {
          err(`jsOp ${e.op} must be ${jsOpResultKind(e.op)}, got ${e.type.kind}`, e.loc);
        }
        const named =
          e.op === "getProp" ||
          e.op === "setProp" ||
          e.op === "callMethod" ||
          e.op === "optCallMethod" ||
          e.op === "globalGet" ||
          e.op === "callSpread"; // the spread expression's source spelling (V8's nullish text spells it)
        if (named !== (e.name !== undefined)) {
          err(`jsOp ${e.op} ${named ? "requires" : "forbids"} a name`, e.loc);
        }
        const arity: Record<string, number | null> = {
          add: 2,
          sub: 2,
          mul: 2,
          div: 2,
          mod: 2,
          pow: 2,
          lt: 2,
          le: 2,
          gt: 2,
          ge: 2,
          eq: 2,
          neq: 2,
          instanceOf: 2,
          neg: 1,
          plus: 1,
          truthy: 1,
          not: 1,
          typeof: 1,
          toStr: 1,
          getProp: 1,
          setProp: 2,
          getIdx: 2,
          setIdx: 3,
          globalGet: 0,
          undefLit: 0,
          nullLit: 0,
          iterNew: 1,
          defineGetter: 3,
          objSpread: 2,
          callSpread: 3, // callee + pre array + spread source
          callMethod: null,
          optCallMethod: null,
          callFn: null,
          callFnThis: null,
          construct: null, // receiver/callee + any number of args
          objLit: null,
          arrLit: null,
          tplStrings: null, // variable length (objLit: key/value pairs; tplStrings: n cooked + n raw)
        };
        const want = arity[e.op];
        if (want !== null && want !== undefined && e.args.length !== want) {
          err(`jsOp ${e.op} takes ${want} arg(s), got ${e.args.length}`, e.loc);
        }
        if (
          want === null &&
          e.op !== "objLit" &&
          e.op !== "arrLit" &&
          e.op !== "tplStrings" &&
          e.args.length < 1
        ) {
          err(`jsOp ${e.op} needs a receiver/callee arg`, e.loc);
        }
        if (e.op === "callFnThis" && e.args.length < 2) {
          err("jsOp callFnThis needs a callee and receiver", e.loc);
        }
        if (e.op === "objLit" && e.args.length % 2 !== 0) {
          err("jsOp objLit takes key/value pairs", e.loc);
        }
        if (e.op === "tplStrings" && e.args.length % 2 !== 0) {
          err("jsOp tplStrings takes n cooked + n raw strings", e.loc);
        }
        for (const a of e.args) {
          if (a.type.kind !== "jsval")
            err(`jsOp ${e.op} arg must be jsval, got ${a.type.kind}`, e.loc);
        }
        break;
      }
      case "jsExit": {
        checkExpr(e.value);
        expectType(e.value, JSVAL, "jsExit operand");
        if (
          !canExitIslandToType(
            e.type,
            (id) => records.get(id),
            (id) => unions.get(id),
          )
        ) {
          err(`jsExit to non-extractable type ${e.type.kind}`, e.loc);
        }
        break;
      }
      case "jsBridgePromise": {
        checkExpr(e.value);
        expectType(e.value, JSVAL, "jsBridgePromise operand");
        // The settled engine value crosses as a HANDLE (or not at all) —
        // plus the ONE converting payload: an `any[]`-declared
        // fulfillment exits Array.isArray-gated by reference AT THE
        // SETTLE (SCR_ISLP_JSVAL_ARR); every other typed use exits later.
        if (
          e.type.kind !== "promise" ||
          (e.type.inner.kind !== "jsval" &&
            e.type.inner.kind !== "void" &&
            !(e.type.inner.kind === "array" && e.type.inner.elem.kind === "jsval"))
        ) {
          err("jsBridgePromise must be a promise of jsval, void, or jsval-element array", e.loc);
        }
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  // `continue` needs an enclosing loop; `break` an enclosing loop OR switch.
  let loopDepth = 0;
  let breakableDepth = 0;
  // Labeled jump targets, innermost last: every loop/switch/labeled-block
  // enters with its labels (possibly none) so `break lbl`/`continue lbl`
  // can resolve to an enclosing entry.
  const labelTargets: { kind: "loop" | "switch" | "block"; labels: string[] }[] = [];

  function checkStmts(stmts: IrStmt[]): void {
    for (const s of stmts) checkStmt(s);
  }

  function checkLoopBody(stmts: IrStmt[], labels: string[] | undefined): void {
    loopDepth++;
    breakableDepth++;
    labelTargets.push({ kind: "loop", labels: labels ?? [] });
    checkStmts(stmts);
    labelTargets.pop();
    breakableDepth--;
    loopDepth--;
  }

  /** The innermost enclosing target carrying `label`, or null. */
  function labelTargetOf(label: string): (typeof labelTargets)[number] | null {
    for (let i = labelTargets.length - 1; i >= 0; i--) {
      if (labelTargets[i]!.labels.includes(label)) return labelTargets[i]!;
    }
    return null;
  }

  function checkStmt(s: IrStmt): void {
    switch (s.kind) {
      case "varDecl": {
        const local = locals.get(s.localId);
        if (!local) err(`varDecl of undeclared local "${s.localId}"`, s.loc);
        // Catch bindings are introduced by tryCatch alone.
        if (local?.type.kind === "caught")
          err(`varDecl of caught-typed local "${s.localId}"`, s.loc);
        if (s.init === null) {
          // Declared, uninitialized: reads before assignment are impossible
          // (tsc TS2454); an uninitialized immutable local is nonsense —
          // EXCEPT a TDZ const (forward-captured): its box is allocated
          // empty at scope entry and the source declaration assigns once.
          if (local && !local.mutable && !local.tdz) {
            err(`varDecl "${local.name}" has no init but is immutable`, s.loc);
          }
          break;
        }
        checkExpr(s.init);
        if (local) expectType(s.init, local.type, `varDecl "${local.name}" init`);
        break;
      }
      case "assign": {
        const binding = locals.get(s.localId) ?? globals.get(s.localId);
        if (s.initializes && !binding?.tdz && globals.get(s.localId)?.initFlag === undefined) {
          err(`initializing assign requires a TDZ binding "${s.localId}"`, s.loc);
        }
        if (!binding) err(`assign to undeclared local/global "${s.localId}"`, s.loc);
        // Global initialization happens via assign inside %init functions,
        // so a const global legitimately receives exactly one assign there;
        // tsc rejects user reassignment of consts, and the lowerer only
        // emits the init-time one. Locals keep the strict check — except a
        // TDZ const, whose source declaration IS an assign into the
        // scope-entry box (tsc rejects user reassignment there too).
        else if (!binding.mutable && locals.has(s.localId) && !locals.get(s.localId)?.tdz) {
          err(`assign to immutable local "${binding.name}"`, s.loc);
        }
        if (binding?.type.kind === "caught") {
          // A caught-typed GLOBAL is a module's recorded evaluation error:
          // its only write stores the module's own catch binding.
          const caughtLocal = s.value.kind === "varRef" ? locals.get(s.value.localId) : undefined;
          if (!globals.has(s.localId) || caughtLocal?.type.kind !== "caught") {
            err(`assign to catch binding "${binding.name}" (frontend must reject)`, s.loc);
          }
        }
        checkExpr(s.value);
        if (binding) expectType(s.value, binding.type, `assign "${binding.name}"`);
        break;
      }
      case "exprStmt":
        checkExpr(s.expr);
        break;
      case "if":
        checkExpr(s.cond);
        expectType(s.cond, BOOL, "if condition");
        checkStmts(s.then);
        if (s.else_) checkStmts(s.else_);
        break;
      case "while":
        checkExpr(s.cond);
        expectType(s.cond, BOOL, "while condition");
        checkLoopBody(s.body, s.labels);
        break;
      case "doWhile":
        checkExpr(s.cond);
        expectType(s.cond, BOOL, "do-while condition");
        checkLoopBody(s.body, s.labels);
        break;
      case "switch": {
        checkExpr(s.disc);
        const dk = s.disc.type.kind;
        if (dk !== "f64" && dk !== "string" && dk !== "bool") {
          err(`switch discriminant must be f64|string|bool, got ${dk}`, s.loc);
        }
        let defaults = 0;
        for (const c of s.cases) {
          if (c.test === null) {
            defaults++;
          } else {
            checkExpr(c.test);
            expectType(c.test, s.disc.type, "switch case test");
          }
          // Case bodies: `break` binds here, `continue` does not.
          breakableDepth++;
          labelTargets.push({ kind: "switch", labels: s.labels ?? [] });
          checkStmts(c.body);
          labelTargets.pop();
          breakableDepth--;
        }
        if (defaults > 1) err(`switch has ${defaults} default clauses`, s.loc);
        break;
      }
      case "for":
        if (s.init) checkStmt(s.init);
        if (s.cond) {
          checkExpr(s.cond);
          expectType(s.cond, BOOL, "for condition");
        }
        if (s.update) checkStmt(s.update);
        checkLoopBody(s.body, s.labels);
        break;
      case "arraySet": {
        checkExpr(s.arr);
        checkExpr(s.index);
        checkExpr(s.value);
        expectType(s.index, F64, "arraySet index");
        if (s.arr.type.kind !== "array") {
          err(`arraySet on non-array ${s.arr.type.kind}`, s.loc);
        } else {
          expectType(s.value, s.arr.type.elem, "arraySet value");
        }
        break;
      }
      case "arraySetLength": {
        checkExpr(s.arr);
        checkExpr(s.length);
        expectType(s.length, F64, "arraySetLength length");
        if (s.arr.type.kind !== "array") {
          err(`arraySetLength on non-array ${s.arr.type.kind}`, s.loc);
        }
        break;
      }
      case "arraySetUndefined":
      case "arrayDelete": {
        checkExpr(s.arr);
        checkExpr(s.index);
        expectType(s.index, F64, `${s.kind} index`);
        if (s.arr.type.kind !== "array") err(`${s.kind} on non-array ${s.arr.type.kind}`, s.loc);
        break;
      }
      case "bytesSet": {
        checkExpr(s.arr);
        checkExpr(s.index);
        checkExpr(s.value);
        expectType(s.index, F64, "bytesSet index");
        expectType(s.value, F64, "bytesSet value");
        if (s.arr.type.kind !== "bytes") {
          err(`bytesSet on non-bytes ${s.arr.type.kind}`, s.loc);
        }
        break;
      }
      case "fieldSet": {
        checkExpr(s.obj);
        checkExpr(s.value);
        const cls = classes.get(s.className);
        const fieldType = classValidation.fields.get(s.className)?.get(s.field);
        if (!cls) err(`fieldSet on undeclared class "${s.className}"`, s.loc);
        else if (!fieldType) err(`class ${s.className} has no field "${s.field}"`, s.loc);
        else {
          expectType(s.obj, { kind: "object", className: s.className }, "fieldSet receiver");
          expectType(s.value, fieldType, `fieldSet ${s.className}.${s.field}`);
        }
        break;
      }
      case "recordSet": {
        checkExpr(s.obj);
        checkSlotValue(s.value);
        const shape = records.get(s.shapeId);
        const field = recordValidation.get(s.shapeId)?.fields.get(s.field);
        if (!shape) err(`recordSet on undeclared shape "${s.shapeId}"`, s.loc);
        else if (!field) err(`shape ${s.shapeId} has no field "${s.field}"`, s.loc);
        else {
          expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordSet receiver");
          expectType(s.value, field, `recordSet ${s.shapeId}.${s.field}`);
        }
        break;
      }
      case "recordKeyDelete": {
        checkExpr(s.obj);
        checkExpr(s.key);
        const shape = records.get(s.shapeId);
        if (!shape) {
          err(`recordKeyDelete on undeclared shape "${s.shapeId}"`, s.loc);
          break;
        }
        if (!shape.indexValue || shape.fields.length > 0) {
          err(`recordKeyDelete on non-pure-index-signature shape ${s.shapeId}`, s.loc);
          break;
        }
        expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordKeyDelete receiver");
        expectType(s.key, STRING, "recordKeyDelete key");
        break;
      }
      case "recordKeySet": {
        checkExpr(s.obj);
        checkExpr(s.key);
        checkExpr(s.value);
        const shape = records.get(s.shapeId);
        if (!shape) {
          err(`recordKeySet on undeclared shape "${s.shapeId}"`, s.loc);
          break;
        }
        if (!shape.indexValue) {
          // Signature-free dispatch: every declared field shares ONE type
          // (the frontend's gate), the value IS that type, and a key miss
          // traps at runtime — so overflowOnly writes cannot exist here.
          const common = shape.fields[0]?.type;
          if (!common || !shape.fields.every((f) => typeEquals(f.type, common))) {
            err(
              `recordKeySet on non-index-signature shape ${s.shapeId} without one shared field type`,
              s.loc,
            );
            break;
          }
          if (s.overflowOnly) {
            err(`recordKeySet overflowOnly on signature-free shape ${s.shapeId}`, s.loc);
          }
          expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordKeySet receiver");
          expectType(s.key, STRING, "recordKeySet key");
          expectType(s.value, common, "recordKeySet value");
          break;
        }
        expectType(s.obj, { kind: "record", shapeId: s.shapeId }, "recordKeySet receiver");
        expectType(s.key, STRING, "recordKeySet key");
        expectType(s.value, shape.indexValue, "recordKeySet value");
        // A dyn value validates against declared fields at runtime; typed
        // values need every declared field to BE the index-value type (the
        // write-through stores directly). overflowOnly writes (a literal
        // key naming no declared field) never collide and skip the check.
        if (
          !s.overflowOnly &&
          shape.indexValue.kind !== "dyn" &&
          !shape.fields.every((f) => typeEquals(f.type, shape.indexValue!))
        ) {
          err(
            `recordKeySet on ${s.shapeId}: declared fields differ from the index-value type`,
            s.loc,
          );
        }
        break;
      }
      case "forOf": {
        const local = locals.get(s.localId);
        if (!local) err(`forOf with undeclared local "${s.localId}"`, s.loc);
        checkExpr(s.iterable);
        if (s.iterable.type.kind !== "array") {
          err(`forOf over non-array ${s.iterable.type.kind}`, s.loc);
        } else if (local && !typeEquals(local.type, s.iterable.type.elem)) {
          err(
            `forOf local "${local.name}" type ${local.type.kind} != element ${s.iterable.type.elem.kind}`,
            s.loc,
          );
        }
        checkLoopBody(s.body, s.labels);
        break;
      }
      case "block":
        if (s.labels !== undefined) {
          // A labeled block is a break-only jump target.
          labelTargets.push({ kind: "block", labels: s.labels });
          checkStmts(s.body);
          labelTargets.pop();
        } else {
          checkStmts(s.body);
        }
        break;
      case "throw":
        checkExpr(s.value);
        // dyn throws are allowed: the dyn node rides the REF cell arm by
        // reference (the JS-lane `throw err` of a dyn argument).
        if (
          s.value.type.kind === "void" ||
          s.value.type.kind === "caught" ||
          s.value.type.kind === "date"
        ) {
          err(`throw of a ${s.value.type.kind} value`, s.loc);
        }
        break;
      case "runtimeFence":
        // The deferred JS compile fence: carries only its message/code.
        if (s.message.length === 0) err(`runtimeFence with an empty message`, s.loc);
        break;
      case "rethrow": {
        // `throw e` of a catch binding: re-raises the saved snapshot.
        const local = locals.get(s.localId) ?? globals.get(s.localId);
        if (!local) err(`rethrow of undeclared local "${s.localId}"`, s.loc);
        else if (local.type.kind !== "caught") {
          err(`rethrow of non-caught local "${s.localId}" (${local.type.kind})`, s.loc);
        }
        break;
      }
      case "tryCatch": {
        if (s.catchBody === null && s.finallyBody === null) {
          err(`tryCatch with neither catch nor finally`, s.loc);
        }
        if (s.catchLocalId !== null) {
          const cl = locals.get(s.catchLocalId);
          if (!cl) err(`tryCatch catch binding "${s.catchLocalId}" has no local entry`, s.loc);
          else if (cl.type.kind !== "caught") {
            err(`tryCatch catch binding "${s.catchLocalId}" is ${cl.type.kind}, not caught`, s.loc);
          }
          if (s.catchBody === null) {
            err(`tryCatch catch binding without a catch body`, s.loc);
          }
        }
        checkStmts(s.tryBody);
        if (s.catchBody) checkStmts(s.catchBody);
        if (s.finallyBody) checkStmts(s.finallyBody);
        break;
      }
      case "break": {
        if (s.label !== undefined) {
          const target = labelTargetOf(s.label);
          if (!target) err(`break to unknown label "${s.label}"`, s.loc);
          break;
        }
        if (breakableDepth === 0) err(`break outside a loop or switch`, s.loc);
        break;
      }
      case "continue": {
        if (s.label !== undefined) {
          const target = labelTargetOf(s.label);
          if (!target) err(`continue to unknown label "${s.label}"`, s.loc);
          else if (target.kind !== "loop") {
            err(`continue to non-loop label "${s.label}"`, s.loc);
          }
          break;
        }
        if (loopDepth === 0) err(`continue outside a loop`, s.loc);
        break;
      }
      case "return":
        if (s.value) {
          checkExpr(s.value);
          expectType(s.value, fn.returnType, "return value");
        } else if (!typeEquals(fn.returnType, VOID)) {
          err(`bare return in non-void function`, s.loc);
        }
        break;
      default: {
        const _exhaustive: never = s;
        void _exhaustive;
      }
    }
  }

  checkStmts(fn.body);

  if (!typeEquals(fn.returnType, VOID) && !alwaysReturns(fn.body, unions)) {
    err(`non-void function may complete without returning`, fn.loc);
  }
}
