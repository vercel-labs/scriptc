/* Maps and Sets keyed by a string-armed nullable union (`string | null`,
 * `string | undefined`, `string | null | undefined`). The union's values are
 * the string pointer itself (nullable-unions.ts), and the collection is a
 * string-key map (SCR_MAP_KEY_STR): a key going in is ENCODED (a unit arm
 * becomes one of two immortal key strings), a key coming out is DECODED
 * (those two addresses become the unit encodings again). The collection
 * therefore hashes and compares its keys as the runtime's string maps do,
 * and no union box exists for the key or anywhere else in the program.
 *
 * The encoding is one-to-one over every byte string, so no string of the
 * program equals a unit arm's key, whatever its bytes. The two key strings
 * are the byte 0xFF and a letter. A string that starts with the byte 0xFF
 * is stored with one more 0xFF in front (ESCAPED) and loses it again on
 * the way out; every other string is stored as it is. A stored string then
 * starts with another byte or with two 0xFF bytes, never with 0xFF and a
 * letter. No string of text starts with 0xFF (strings are WTF-8,
 * scr_string.h), so the escape runs only for a string that some
 * constructor copied from bytes that are not text; decoding compares
 * addresses first, and only an encoded unit arm ever stores those two. */
import type { IrType, IrUnionDef } from "../../ir/ir.js";
import type { BlockBuilder } from "./blocks.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { NULLABLE_NULL, type NullableUnion, type NullableUnions } from "./nullable-unions.js";
import { mapKeyAccess, type MapKeyAccess } from "./shapes.js";

/** What the key encoding reads of a helper generator's host. An emitter
 * hands over its `shapeHost`, never itself: an emitter given where this
 * interface is declared would become a dynamic value in the compiler's own
 * build. */
export interface UnionKeyHost {
  readonly nullableUnions: NullableUnions;
  readonly unionsById: ReadonlyMap<string, IrUnionDef>;
  readonly sizeType: string;
  declare(declaration: string): void;
}

/** The key string that stands for `undefined`. */
export const UNIT_KEY_UNDEFINED = "@sc_key_undefined";
/** The key string that stands for `null`. */
export const UNIT_KEY_NULL = "@sc_key_null";
/** The one-byte string an escaped key starts with. */
export const UNIT_KEY_ESCAPE = "@sc_key_escape";
/** `ptr @sc_ukey_escape(ptr string)`: the escaped key of a borrowed string
 * that starts with 0xFF, +1; null for the empty string (its first data
 * byte is its terminator, not a byte of the string). */
export const UNIT_KEY_ESCAPE_FN = "@sc_ukey_escape";
/** `ptr @sc_ukey_unescape(ptr stored)`: the string of a borrowed escaped
 * key, +1; null when `stored` is shorter than an escaped key. */
export const UNIT_KEY_UNESCAPE_FN = "@sc_ukey_unescape";

/** The bytes of a key string: 0xFF, which no string of text holds, then a
 * letter that tells the two unit arms apart; 0xFF alone for the escape. */
export function unitKeyBytes(symbol: string): Uint8Array {
  if (symbol === UNIT_KEY_ESCAPE) return Uint8Array.from([0xff]);
  return Uint8Array.from([0xff, symbol === UNIT_KEY_NULL ? 0x6e : 0x75]);
}

/** The two helpers of the escape (module scope, emitted with the key
 * strings): cold, and called only for a string that starts with 0xFF. */
export function unitKeyHelperDefinitions(S: string): string[] {
  const header = `{ ${S}, ${S}, ${S}, [0 x i8] }`;
  return [
    `define internal ptr ${UNIT_KEY_ESCAPE_FN}(ptr %s) cold noinline {`,
    `entry:`,
    `  %lenp = getelementptr inbounds ${header}, ptr %s, i32 0, i32 1`,
    `  %len = load ${S}, ptr %lenp`,
    `  %empty = icmp eq ${S} %len, 0`,
    `  br i1 %empty, label %none, label %make`,
    `none:`,
    `  ret ptr null`,
    `make:`,
    `  %escaped = call ptr @scr_str_concat(ptr ${UNIT_KEY_ESCAPE}, ptr %s)`,
    `  ret ptr %escaped`,
    `}`,
    ``,
    `define internal ptr ${UNIT_KEY_UNESCAPE_FN}(ptr %s) cold noinline {`,
    `entry:`,
    `  %lenp = getelementptr inbounds ${header}, ptr %s, i32 0, i32 1`,
    `  %len = load ${S}, ptr %lenp`,
    `  %short = icmp ult ${S} %len, 2`,
    `  br i1 %short, label %none, label %make`,
    `none:`,
    `  ret ptr null`,
    `make:`,
    `  %rest = getelementptr inbounds ${header}, ptr %s, i32 0, i32 3, i32 1`,
    `  %count = sub ${S} %len, 1`,
    `  %string = call ptr @scr_str_new(ptr %rest, ${S} %count)`,
    `  ret ptr %string`,
    `}`,
    ``,
  ];
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

/** Whether the string `string` (never null) starts with the byte 0xFF. */
function startsWithEscapeByte(B: BlockBuilder, host: UnionKeyHost, string: string): string {
  const S = host.sizeType;
  const at = B.tmp(),
    first = B.tmp(),
    odd = B.tmp();
  B.line(
    `${at} = getelementptr inbounds { ${S}, ${S}, ${S}, [0 x i8] }, ptr ${string}, i32 0, i32 3, i32 0`,
  );
  B.line(`${first} = load i8, ptr ${at}`);
  B.line(`${odd} = icmp eq i8 ${first}, -1`);
  return odd;
}

/** The key the collection stores for the union value `value`: the string
 * itself, the key string of its unit arm, or the escaped string. Other key
 * types pass through. The result is borrowed like `value`; an escaped
 * string is a temporary the frame owns and releases. For a use inside a
 * loop this module's caller emits itself, see encodeCollectionKeyIn. */
export function encodeCollectionKey(host: LlvmEmitterContext, key: IrType, value: string): string {
  const B = host.B;
  const { stored, temporary } = encodeCollectionKeyIn(B, host.shapeHost, key, value);
  if (temporary === null) return stored;
  // NULL on the ordinary path. The frame owns the temporary through a slot
  // it releases only when filled, so a key that is not escaped pays one
  // test after its operation and no release call.
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  B.line(`store ptr ${temporary}, ptr ${slot}`);
  host.ownSlot(slot, { kind: "string" }, true);
  return stored;
}

/** encodeCollectionKey in another block builder (helper generators), or
 * where the caller releases the temporary itself: `temporary` is null for
 * other key types, else a value that is NULL or the +1 escaped string,
 * which the caller releases after the operation (releaseKeyTemporary). */
export function encodeCollectionKeyIn(
  B: BlockBuilder,
  host: UnionKeyHost,
  key: IrType,
  value: string,
): { stored: string; temporary: string | null } {
  const nullable = host.nullableUnions.stringKey(key);
  if (nullable === null) return { stored: value, temporary: null };
  let isUnit = B.tmp(),
    encoded = B.tmp();
  B.line(`${isUnit} = icmp eq ptr ${value}, null`);
  B.line(
    `${encoded} = select i1 ${isUnit}, ptr ${unitKey(host, nullable, nullable.unitTag)}, ptr ${value}`,
  );
  if (nullable.nullTag >= 0) {
    const isNull = B.tmp(),
      both = B.tmp(),
      either = B.tmp();
    B.line(`${isNull} = icmp eq ptr ${value}, ${NULLABLE_NULL}`);
    B.line(`${both} = select i1 ${isNull}, ptr ${UNIT_KEY_NULL}, ptr ${encoded}`);
    B.line(`${either} = or i1 ${isUnit}, ${isNull}`);
    encoded = both;
    isUnit = either;
  }
  // A string that starts with 0xFF is escaped; a unit arm's key string
  // starts with it too and passes.
  const odd = startsWithEscapeByte(B, host, encoded);
  const isString = B.tmp(),
    escapes = B.tmp();
  B.line(`${isString} = xor i1 ${isUnit}, true`);
  B.line(`${escapes} = and i1 ${odd}, ${isString}`);
  const from = B.currentLabel();
  const slow = B.newLabel("ukey.escape"),
    join = B.newLabel("ukey.key");
  B.condBr(escapes, slow, join);
  B.startBlock(slow);
  const escaped = B.tmp(),
    none = B.tmp(),
    picked = B.tmp();
  B.line(`${escaped} = call ptr ${UNIT_KEY_ESCAPE_FN}(ptr ${encoded})`);
  B.line(`${none} = icmp eq ptr ${escaped}, null`);
  B.line(`${picked} = select i1 ${none}, ptr ${encoded}, ptr ${escaped}`);
  B.br(join);
  B.startBlock(join);
  const stored = B.tmp(),
    temporary = B.tmp();
  B.line(`${stored} = phi ptr [ ${encoded}, %${from} ], [ ${picked}, %${slow} ]`);
  B.line(`${temporary} = phi ptr [ null, %${from} ], [ ${escaped}, %${slow} ]`);
  return { stored, temporary };
}

/** Releases the temporary of encodeCollectionKeyIn or decodeBorrowedKeyIn
 * (NULL or a +1 string) after the operation that read it. */
export function releaseKeyTemporary(B: BlockBuilder, host: UnionKeyHost, temporary: string): void {
  host.declare(`declare void @scr_str_release(ptr)`);
  const held = B.tmp();
  B.line(`${held} = icmp ne ptr ${temporary}, null`);
  const drop = B.newLabel("ukey.drop"),
    done = B.newLabel("ukey.dropped");
  B.condBr(held, drop, done);
  B.startBlock(drop);
  B.line(`call void @scr_str_release(ptr ${temporary})`);
  B.br(done);
  B.startBlock(done);
}

/** The union value of the +1 stored key `stored`. Ownership carries over:
 * a +1 string stays +1 (an escaped key is released for its +1 string), and
 * the unit encodings own nothing. */
export function decodeCollectionKey(host: LlvmEmitterContext, key: IrType, stored: string): string {
  return decodeKeyIn(host.B, host.shapeHost, key, stored, true).value;
}

/** The union value of the BORROWED stored key `stored` in another block
 * builder (helper generators): `temporary` is null for other key types,
 * else a value that is NULL or the +1 string of an escaped key, which
 * `value` then is; the caller releases it after its use
 * (releaseKeyTemporary). */
export function decodeBorrowedKeyIn(
  B: BlockBuilder,
  host: UnionKeyHost,
  key: IrType,
  stored: string,
): { value: string; temporary: string | null } {
  return decodeKeyIn(B, host, key, stored, false);
}

function decodeKeyIn(
  B: BlockBuilder,
  host: UnionKeyHost,
  key: IrType,
  stored: string,
  owned: boolean,
): { value: string; temporary: string | null } {
  const nullable = host.nullableUnions.stringKey(key);
  if (nullable === null) return { value: stored, temporary: null };
  let isUnit = B.tmp(),
    decoded = B.tmp();
  B.line(`${isUnit} = icmp eq ptr ${stored}, ${unitKey(host, nullable, nullable.unitTag)}`);
  B.line(`${decoded} = select i1 ${isUnit}, ptr null, ptr ${stored}`);
  if (nullable.nullTag >= 0) {
    const isNull = B.tmp(),
      both = B.tmp(),
      either = B.tmp();
    B.line(`${isNull} = icmp eq ptr ${stored}, ${UNIT_KEY_NULL}`);
    B.line(`${both} = select i1 ${isNull}, ptr ${NULLABLE_NULL}, ptr ${decoded}`);
    B.line(`${either} = or i1 ${isUnit}, ${isNull}`);
    decoded = both;
    isUnit = either;
  }
  // A stored string that starts with 0xFF is an escaped key.
  const odd = startsWithEscapeByte(B, host, stored);
  const isString = B.tmp(),
    escaped = B.tmp();
  B.line(`${isString} = xor i1 ${isUnit}, true`);
  B.line(`${escaped} = and i1 ${odd}, ${isString}`);
  const from = B.currentLabel();
  const slow = B.newLabel("ukey.unescape"),
    join = B.newLabel("ukey.value");
  B.condBr(escaped, slow, join);
  B.startBlock(slow);
  const string = B.tmp(),
    none = B.tmp(),
    picked = B.tmp();
  B.line(`${string} = call ptr ${UNIT_KEY_UNESCAPE_FN}(ptr ${stored})`);
  B.line(`${none} = icmp eq ptr ${string}, null`);
  B.line(`${picked} = select i1 ${none}, ptr ${decoded}, ptr ${string}`);
  let last = slow;
  if (owned) {
    // The +1 escaped key gives way to its +1 string.
    host.declare(`declare void @scr_str_release(ptr)`);
    const drop = B.newLabel("ukey.swap");
    B.condBr(none, join, drop);
    B.startBlock(drop);
    B.line(`call void @scr_str_release(ptr ${stored})`);
    B.br(join);
    last = drop;
  } else B.br(join);
  B.startBlock(join);
  const value = B.tmp(),
    temporary = B.tmp();
  const incoming = owned
    ? `[ ${decoded}, %${from} ], [ ${picked}, %${slow} ], [ ${picked}, %${last} ]`
    : `[ ${decoded}, %${from} ], [ ${picked}, %${slow} ]`;
  B.line(`${value} = phi ptr ${incoming}`);
  if (owned) return { value, temporary: null };
  B.line(`${temporary} = phi ptr [ null, %${from} ], [ ${string}, %${slow} ]`);
  return { value, temporary };
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
