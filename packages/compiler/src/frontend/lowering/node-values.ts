/** What a Node value IS in the pinned Node release, for the values a
 * JavaScript source names and native code has no value for.
 *
 * A JavaScript source can read every Node global, every member of a builtin
 * module and every member of the global objects. Where a lowering has a
 * value, the read answers it. Where none has, the answer depends on what Node
 * has there, and the census generated from the pinned Node
 * (builtin-module-members.generated.ts) is the one place that says:
 *
 *   - Node does not define the name by default: the read answers what Node
 *     answers (`typeof` is "undefined", a property read is undefined, a bare
 *     identifier throws ReferenceError).
 *   - Node has a function or a class: the read answers a function value with
 *     Node's name and length that refuses when it is called or constructed
 *     (builtin-function-fences.ts), so `typeof`, identity and feature tests
 *     are Node's and a use is refused by name.
 *   - Node has any other value: the read is refused by name.
 *
 * The compiler never represents such a value as something else. In
 * particular it is never a string: a placeholder the program can observe is
 * a wrong answer to `typeof`, to String() and to every member read. */
import {
  BUILTIN_MODULE_MEMBERS,
  NODE_GLOBALS,
  NODE_GLOBAL_OBJECT_MEMBERS,
  NODE_OBJECT_PROTOTYPE_MEMBERS,
  NODE_PROCESS_COMMONJS_MAIN_MEMBERS,
  NODE_PROCESS_IPC_MEMBERS,
  type NodeMemberCensus,
} from "./builtin-module-members.generated.js";

/** What Node has under a name: a function with its `length`, or a value with
 * its `typeof` ("object" for null; "throws" for an accessor that throws when
 * it is read; "platform" for a member whose value depends on the operating
 * system). */
export type NodeValueKind =
  | { readonly kind: "function"; readonly length: number }
  | { readonly kind: "value"; readonly type: string };

const parsed = new Map<NodeMemberCensus, ReadonlyMap<string, NodeValueKind>>();

/** The census text of one object as a map. Parsed on first use: a build
 * that reads no unlowered value never pays for it. */
function kindsOf(census: NodeMemberCensus): ReadonlyMap<string, NodeValueKind> {
  const cached = parsed.get(census);
  if (cached !== undefined) return cached;
  const kinds = new Map<string, NodeValueKind>();
  for (const entry of census.functions.split(" ")) {
    const at = entry.indexOf("=");
    if (at > 0)
      kinds.set(entry.slice(0, at), { kind: "function", length: Number(entry.slice(at + 1)) });
  }
  for (const entry of census.values.split(" ")) {
    const at = entry.indexOf("=");
    if (at > 0) kinds.set(entry.slice(0, at), { kind: "value", type: entry.slice(at + 1) });
  }
  parsed.set(census, kinds);
  return kinds;
}

/** What Node's global object has under `name`, or null when Node does not
 * define the name by default (`localStorage` without its flag, `window`,
 * a global of a later ECMAScript edition). */
export function nodeGlobalKind(name: string): NodeValueKind | null {
  return kindsOf(NODE_GLOBALS).get(name) ?? null;
}

/** What the builtin module `module` exports under `name`: null when its
 * exports object has no such own property, undefined when the module is
 * not in the census. */
export function nodeModuleMemberKind(
  module: string,
  name: string,
): NodeValueKind | null | undefined {
  if (!Object.hasOwn(BUILTIN_MODULE_MEMBERS, module)) return undefined;
  const census = BUILTIN_MODULE_MEMBERS[module];
  if (census === undefined) return undefined;
  return kindsOf(census).get(name) ?? null;
}

/** What the global object `object` ("process", "performance", "console",
 * "crypto", "navigator", "crypto.subtle") has under `name`, own or
 * inherited: null when it has no such member, undefined when the object is
 * not in the census. For a global function or class with statics ("URL")
 * the census lists its own properties only, without `name` and `length`. */
export function nodeGlobalObjectMemberKind(
  object: string,
  name: string,
): NodeValueKind | null | undefined {
  if (!Object.hasOwn(NODE_GLOBAL_OBJECT_MEMBERS, object)) return undefined;
  const census = NODE_GLOBAL_OBJECT_MEMBERS[object];
  if (census === undefined) return undefined;
  return kindsOf(census).get(name) ?? null;
}

const objectPrototypeMembers: ReadonlySet<string> = new Set(
  NODE_OBJECT_PROTOTYPE_MEMBERS.split(" "),
);

/** Every member of the global object `object` except the ones it inherits
 * from Object.prototype, in the census's order, or undefined when the
 * census does not describe `object`. */
export function nodeGlobalObjectMembers(
  object: string,
): readonly (readonly [string, NodeValueKind])[] | undefined {
  if (!Object.hasOwn(NODE_GLOBAL_OBJECT_MEMBERS, object)) return undefined;
  const census = NODE_GLOBAL_OBJECT_MEMBERS[object];
  if (census === undefined) return undefined;
  return [...kindsOf(census)].filter(([name]) => !objectPrototypeMembers.has(name));
}

const ipcMembers: ReadonlySet<string> = new Set(NODE_PROCESS_IPC_MEMBERS.split(" "));
const commonJsMainMembers: ReadonlySet<string> = new Set(
  NODE_PROCESS_COMMONJS_MAIN_MEMBERS.split(" "),
);

/** Whether the process object has `name` only when the process has an IPC
 * channel (`process.connected`, `process.channel`, `process.send`). */
export function processMemberNeedsIpc(name: string): boolean {
  return ipcMembers.has(name);
}

/** Whether the process object has `name` only when the entry module is
 * CommonJS (`process.mainModule`). */
export function processMemberNeedsCommonJsMain(name: string): boolean {
  return commonJsMainMembers.has(name);
}
