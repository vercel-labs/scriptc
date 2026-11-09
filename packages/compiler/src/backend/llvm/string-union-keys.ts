/* Maps and Sets keyed by a string-armed nullable union (`string | null`,
 * `string | undefined`, `string | null | undefined`). The union's values are
 * the string pointer itself (nullable-unions.ts), and the collection is a
 * string-key map (SCR_MAP_KEY_STR): a key going in is ENCODED (a unit arm
 * becomes one of two immortal key strings), a key coming out is DECODED
 * (those two addresses become the unit encodings again). The collection
 * therefore hashes and compares its keys as the runtime's string maps do,
 * and no union box exists for the key or anywhere else in the program.
 *
 * The two key strings hold a 0xFF byte. Every string of a program is stored
 * as WTF-8 (scr_string.h), which has no such byte, so no string of the
 * program equals either of them; decoding compares addresses, and only an
 * encoded unit arm ever stores those addresses. */
import type { IrType, IrUnionDef } from "../../ir/ir.js";
import type { BlockBuilder } from "./blocks.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { NULLABLE_NULL, type NullableUnion, type NullableUnions } from "./nullable-unions.js";
import { mapKeyAccess, type MapKeyAccess } from "./shapes.js";

/** What the key encoding reads of an emitter or a helper generator. */
export interface UnionKeyHost {
  readonly nullableUnions: NullableUnions;
  readonly unionsById: ReadonlyMap<string, IrUnionDef>;
}

/** The key string that stands for `undefined`. */
export const UNIT_KEY_UNDEFINED = "@sc_key_undefined";
/** The key string that stands for `null`. */
export const UNIT_KEY_NULL = "@sc_key_null";

/** The bytes of a unit arm's key string: 0xFF, which WTF-8 never holds,
 * then a letter that tells the two apart. */
export function unitKeyBytes(symbol: string): Uint8Array {
  return Uint8Array.from([0xff, symbol === UNIT_KEY_NULL ? 0x6e : 0x75]);
}

/** The key string of the unit arm `tag` of a string-key union. */
function unitKey(host: UnionKeyHost, nullable: NullableUnion, tag: number): string {
  const arm = host.unionsById.get(nullable.unionId)?.arms[tag];
  return arm?.kind === "nullT" ? UNIT_KEY_NULL : UNIT_KEY_UNDEFINED;
}

/** How a collection keyed by `key` passes its keys to the runtime: string
 * access for a string-key union, the type's own access otherwise. */
export function collectionKeyAccess(host: UnionKeyHost, key: IrType): MapKeyAccess {
  return host.nullableUnions.stringKey(key) !== null ? "str" : mapKeyAccess(key);
}

/** The key the collection stores for the union value `value`: the string
 * itself, or the key string of its unit arm. Other key types pass through.
 * The result is borrowed like `value` (key strings are immortal). */
export function encodeCollectionKey(host: LlvmEmitterContext, key: IrType, value: string): string {
  return encodeCollectionKeyIn(host.B, host, key, value);
}

/** encodeCollectionKey in another block builder (helper generators). */
export function encodeCollectionKeyIn(
  B: BlockBuilder,
  host: UnionKeyHost,
  key: IrType,
  value: string,
): string {
  const nullable = host.nullableUnions.stringKey(key);
  if (nullable === null) return value;
  const isUnit = B.tmp(),
    encoded = B.tmp();
  B.line(`${isUnit} = icmp eq ptr ${value}, null`);
  B.line(
    `${encoded} = select i1 ${isUnit}, ptr ${unitKey(host, nullable, nullable.unitTag)}, ptr ${value}`,
  );
  if (nullable.nullTag < 0) return encoded;
  const isNull = B.tmp(),
    both = B.tmp();
  B.line(`${isNull} = icmp eq ptr ${value}, ${NULLABLE_NULL}`);
  B.line(`${both} = select i1 ${isNull}, ptr ${UNIT_KEY_NULL}, ptr ${encoded}`);
  return both;
}

/** The union value of the stored key `stored`. Ownership carries over: a
 * +1 string stays +1, and the unit encodings own nothing. */
export function decodeCollectionKey(host: LlvmEmitterContext, key: IrType, stored: string): string {
  return decodeCollectionKeyIn(host.B, host, key, stored);
}

/** decodeCollectionKey in another block builder (helper generators). */
export function decodeCollectionKeyIn(
  B: BlockBuilder,
  host: UnionKeyHost,
  key: IrType,
  stored: string,
): string {
  const nullable = host.nullableUnions.stringKey(key);
  if (nullable === null) return stored;
  const isUnit = B.tmp(),
    decoded = B.tmp();
  B.line(`${isUnit} = icmp eq ptr ${stored}, ${unitKey(host, nullable, nullable.unitTag)}`);
  B.line(`${decoded} = select i1 ${isUnit}, ptr null, ptr ${stored}`);
  if (nullable.nullTag < 0) return decoded;
  const isNull = B.tmp(),
    both = B.tmp();
  B.line(`${isNull} = icmp eq ptr ${stored}, ${UNIT_KEY_NULL}`);
  B.line(`${both} = select i1 ${isNull}, ptr ${NULLABLE_NULL}, ptr ${decoded}`);
  return both;
}

/** Runs `body` with each index from zero below `count` (a double), in
 * order. */
export function emitIndexLoop(
  host: LlvmEmitterContext,
  count: string,
  body: (index: string) => void,
): void {
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca double`);
  B.line(`store double 0.0, ptr ${slot}`);
  const head = B.newLabel("ukey.head"),
    step = B.newLabel("ukey.step"),
    done = B.newLabel("ukey.done");
  B.br(head);
  B.startBlock(head);
  const index = B.tmp(),
    more = B.tmp();
  B.line(`${index} = load double, ptr ${slot}`);
  B.line(`${more} = fcmp olt double ${index}, ${count}`);
  B.condBr(more, step, done);
  B.startBlock(step);
  body(index);
  const next = B.tmp();
  B.line(`${next} = fadd double ${index}, 1.0`);
  B.line(`store double ${next}, ptr ${slot}`);
  B.br(head);
  B.startBlock(done);
}
