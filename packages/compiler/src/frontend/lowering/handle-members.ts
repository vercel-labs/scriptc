/* Members of native handle classes that take and return plain values
 * (numbers, strings, booleans): one row per member, naming the builtin that
 * implements it.
 *
 * A row is a method-shaped name for a builtin's signature row
 * (ir/builtin-signatures.ts) and restates nothing that row holds. The
 * builtin's first argument is the handle, its other arguments are the
 * member's parameters and its result is the member's result; a `void` result
 * makes the call a statement, because Node returns the handle there. Whether
 * the builtin can throw, its runtime symbol and its link feature are
 * attributes of the builtin, not of the member.
 *
 * The bundled declaration of the class is checked against the table
 * (handle-members.test.ts): every member it declares is a row whose
 * signature agrees with the declaration, or is one of the members a
 * dedicated lowering compiles. A member with no row and no dedicated
 * lowering is refused by name where it is used. */
import { libFnSignatures } from "../../ir/builtin-signatures.js";
import type { IrLibFn, IrType } from "../../ir/ir.js";

export interface HandleMember {
  /** The builtin that implements the member; its first argument is the handle. */
  readonly fn: IrLibFn;
  /** How many trailing parameters a caller may omit. The builtin then takes
   * one argument more than the member has parameters: whether the last
   * parameter was given. */
  readonly optional?: number;
}

export type HandleMemberTable = Readonly<Record<string, HandleMember>>;

/** dgram.Socket (handle kind dgramSocket): the socket options and
 * disconnect(). bind, connect, send, address, close, ref, unref and the
 * listener registrations take callbacks, overloads or records and are
 * lowered in lower-dgram.ts. */
export const DGRAM_SOCKET_MEMBERS: HandleMemberTable = {
  setBroadcast: { fn: "dgram.setBroadcast" },
  setTTL: { fn: "dgram.setTTL" },
  setMulticastTTL: { fn: "dgram.setMulticastTTL" },
  setMulticastLoopback: { fn: "dgram.setMulticastLoopback" },
  setMulticastInterface: { fn: "dgram.setMulticastInterface" },
  addMembership: { fn: "dgram.addMembership", optional: 1 },
  dropMembership: { fn: "dgram.dropMembership", optional: 1 },
  getRecvBufferSize: { fn: "dgram.getRecvBufferSize" },
  getSendBufferSize: { fn: "dgram.getSendBufferSize" },
  setRecvBufferSize: { fn: "dgram.setRecvBufferSize" },
  setSendBufferSize: { fn: "dgram.setSendBufferSize" },
  getSendQueueSize: { fn: "dgram.getSendQueueSize" },
  getSendQueueCount: { fn: "dgram.getSendQueueCount" },
  disconnect: { fn: "dgram.disconnect" },
};

/** A member's parameter and result types, read from its builtin. */
export interface HandleMemberSignature {
  readonly params: readonly IrType[];
  readonly result: IrType;
}

export function handleMemberSignature(member: HandleMember): HandleMemberSignature {
  const signature = libFnSignatures()[member.fn];
  // The handle comes first; a member with omittable parameters ends with
  // the builtin's "was the last one given" flag.
  const end = signature.argTypes.length - (member.optional === undefined ? 0 : 1);
  const params: IrType[] = [];
  for (let i = 1; i < end; i++) {
    const param = signature.argTypes[i];
    if (param === null || param === undefined)
      throw new Error(`handle member builtin ${member.fn} has an untyped parameter`);
    params.push(param);
  }
  return { params, result: signature.result };
}

/** How a declaration spells a plain parameter or result type. */
export function handleMemberTypeName(type: IrType): string {
  switch (type.kind) {
    case "bool":
      return "boolean";
    case "f64":
      return "number";
    case "string":
      return "string";
    case "void":
      return "void";
    default:
      throw new Error(`handle members take and return plain values, not ${type.kind}`);
  }
}
