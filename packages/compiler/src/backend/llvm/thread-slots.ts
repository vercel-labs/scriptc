/* ThreadSlots (@scriptc/experimental): the slots.* intrinsics (scr_slots.c,
 * frontend/lowering/thread-slots.ts).
 *
 * Each family name has one `{ ptr, i32, i32, ptr, ptr }` ScrSlots block,
 * an internal global that is thread-local where module globals are. A key
 * class's hierarchy carries an i32 slot word after its header words
 * (classSlotWordIndex). A read is inline: the slot word, then the page
 * and the entry,
 *
 *     page = word >> 10 < block.npages ? block.pages[word >> 10] : none
 *     value = page[word & 1023]
 *
 * and absent pages are a shared page of NULL entries (scr_slots_none), so
 * a key without a value reads NULL, the undefined of `V | undefined`. Set
 * and delete call the runtime, which holds one reference to each value and
 * releases the value it replaces or removes. */
import { InternalCompilerError } from "../../errors.js";
import { isUnitType, typeKey, type IrType } from "../../ir/ir.js";
import { classSlotWordIndex, classStructSym } from "./classes.js";
import { llvmCommentText } from "./common.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { releaseSym } from "./shapes.js";

const BLOCK = "{ ptr, i32, i32, ptr, ptr }";

/** The slots.* intrinsics. */
export function emitThreadSlotsIntrinsic(
  host: LlvmEmitterContext,
  e: ExprOf<"intrinsic">,
): LlValue {
  const B = host.B;
  const [nameArg, slotsArg, keyArg, valueArg] = e.args;
  if (nameArg?.kind !== "strLit" || slotsArg === undefined || keyArg === undefined)
    throw new InternalCompilerError(`llvm emitter bug: ${e.name} operands`);
  const block = host.threadSlotsBlock(nameArg.value);
  // The slots value is read for its effects (a module const's TDZ check).
  const slots = host.emitReadReceiver(slotsArg);
  const key = host.emitReadReceiver(keyArg);
  const value = valueArg !== undefined ? host.emitExpr(valueArg) : null;
  if (B.isTerminated()) return { name: "", type: e.type };
  if (keyArg.type.kind !== "object")
    throw new InternalCompilerError(`llvm emitter bug: ${e.name} key of kind ${keyArg.type.kind}`);
  const className = keyArg.type.className;
  const word = B.tmp();
  B.line(
    `${word} = getelementptr inbounds %${classStructSym(className)}, ptr ${key.name}, i64 0, i32 ${classSlotWordIndex(host.classMetaOf(className))}`,
  );
  switch (e.name) {
    case "slots.get": {
      const read = readSlot(host, block, word);
      if (host.nullableUnions.of(e.type) !== null)
        return host.own({ name: host.retainFrame(read, e.type), type: e.type });
      return boxedRead(host, read, e.type);
    }
    case "slots.has": {
      const read = readSlot(host, block, word);
      const has = B.tmp();
      B.line(`${has} = icmp ne ptr ${read}, null`);
      return { name: has, type: e.type };
    }
    case "slots.delete": {
      host.declare(`declare zeroext i1 @scr_slots_delete(ptr, ptr)`);
      const had = B.tmp();
      B.line(`${had} = call zeroext i1 @scr_slots_delete(ptr ${block}, ptr ${word})`);
      return { name: had, type: e.type };
    }
    case "slots.set": {
      if (value === null) throw new InternalCompilerError("llvm emitter bug: slots.set value");
      // The value moves into the block.
      host.toHeap(value);
      host.declare(`declare void @scr_slots_set(ptr, ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_slots_set(ptr ${block}, ptr ${key.name}, ptr ${word}, ptr ${value.name}, ptr ${releaseSym(host.shapeHost, value.type)})`,
      );
      if (e.type.kind === "void") return { name: "", type: e.type };
      return host.own({ name: host.retainFrame(slots.name, e.type), type: e.type });
    }
    default:
      throw new InternalCompilerError(`llvm emitter bug: unknown intrinsic ${e.name}`);
  }
}

/** A read as a tagged union box, for `V | undefined` types that the module
 * keeps boxed (Map keys and Set elements of that type): the value's arm, or
 * the interned undefined instance for NULL. */
function boxedRead(host: LlvmEmitterContext, read: string, type: IrType): LlValue {
  const B = host.B;
  const def = type.kind === "union" ? host.unionsById.get(type.unionId) : undefined;
  const refTag = def?.arms.findIndex((a) => !isUnitType(a)) ?? -1;
  const unitTag = def?.arms.findIndex((a) => a.kind === "undefinedT") ?? -1;
  if (def === undefined || refTag < 0 || unitTag < 0 || def.arms.length !== 2)
    throw new InternalCompilerError(`llvm emitter bug: slots.get of type ${typeKey(type)}`);
  const result = B.slot();
  B.entryAllocas.push(`${result} = alloca ptr`);
  const has = B.tmp();
  B.line(`${has} = icmp ne ptr ${read}, null`);
  const some = B.newLabel("slots.some"),
    none = B.newLabel("slots.none"),
    done = B.newLabel("slots.box");
  B.condBr(has, some, none);
  B.startBlock(some);
  const arm = def.arms[refTag]!;
  const box = host.unionNewOwned(def.id, refTag, { name: host.retainHeap(read, arm), type: arm });
  B.line(`store ptr ${box}, ptr ${result}`);
  B.br(done);
  B.startBlock(none);
  B.line(`store ptr ${host.unitInstanceRef(def.id, unitTag)}, ptr ${result}`);
  B.br(done);
  B.startBlock(done);
  const out = B.tmp();
  B.line(`${out} = load ptr, ptr ${result}`);
  return host.own({ name: out, type });
}

/** This thread's value for the slot word at `word`, borrowed, or NULL. */
function readSlot(host: LlvmEmitterContext, block: string, word: string): string {
  const B = host.B;
  host.declare(`@scr_slots_none = external constant [1024 x ptr]`);
  const index = B.tmp(),
    page = B.tmp(),
    pages = B.tmp(),
    count = B.tmp(),
    inRange = B.tmp();
  B.line(`${index} = load atomic i32, ptr ${word} monotonic, align 4`);
  B.line(`${page} = lshr i32 ${index}, 10`);
  B.line(`${count} = getelementptr inbounds ${BLOCK}, ptr ${block}, i64 0, i32 1`);
  const npages = B.tmp();
  B.line(`${npages} = load i32, ptr ${count}`);
  B.line(`${inRange} = icmp ult i32 ${page}, ${npages}`);
  const result = B.slot();
  B.entryAllocas.push(`${result} = alloca ptr`);
  B.line(`store ptr null, ptr ${result}`);
  const found = B.newLabel("slots.page"),
    done = B.newLabel("slots.j");
  B.condBr(inRange, found, done);
  B.startBlock(found);
  B.line(`${pages} = load ptr, ptr ${block}`);
  const pageIndex = B.tmp(),
    pagePtr = B.tmp(),
    entries = B.tmp(),
    entryIndex = B.tmp(),
    entryWide = B.tmp(),
    entry = B.tmp(),
    v = B.tmp();
  B.line(`${pageIndex} = zext i32 ${page} to i64`);
  B.line(`${pagePtr} = getelementptr inbounds ptr, ptr ${pages}, i64 ${pageIndex}`);
  B.line(`${entries} = load ptr, ptr ${pagePtr}`);
  B.line(`${entryIndex} = and i32 ${index}, 1023`);
  B.line(`${entryWide} = zext i32 ${entryIndex} to i64`);
  B.line(`${entry} = getelementptr inbounds ptr, ptr ${entries}, i64 ${entryWide}`);
  B.line(`${v} = load ptr, ptr ${entry}`);
  B.line(`store ptr ${v}, ptr ${result}`);
  B.br(done);
  B.startBlock(done);
  const out = B.tmp();
  B.line(`${out} = load ptr, ptr ${result}`);
  return out;
}

/** The ScrSlots block definitions of the families a module uses. */
export function threadSlotsBlockDefinitions(
  blocks: ReadonlyMap<string, string>,
  threadLocal: boolean,
): string[] {
  const tl = threadLocal ? "thread_local " : "";
  return [...blocks].map(
    ([name, sym]) =>
      `${sym} = internal ${tl}global ${BLOCK} zeroinitializer ; ThreadSlots ${llvmCommentText(JSON.stringify(name))}`,
  );
}
