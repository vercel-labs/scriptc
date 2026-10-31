import type { LlvmEmitterContext } from "./expr-context.js";

/** Alias categories of typed-array storage. A ScrBytes header (length,
 * data pointer, shared backing) is fixed at construction and only ever
 * written by runtime code, never by emitted code. Element storage is one
 * category for every element type: views of different types may share a
 * buffer. Neither overlaps the other, a native field, array storage or a
 * module global's slot, so element stores leave header loads and global
 * receiver slots loop-invariant. Untagged accesses and calls still alias
 * every category.
 *
 * Header loads that only bound or address an access to the view are also
 * `!invariant.load`: no store or call between the construction of a view
 * and its release changes them, and their values reach only that access,
 * which runs while the view is alive. Without it, a data pointer load
 * ahead of a bounds branch is sunk into the in-bounds block, and LICM keeps
 * a conditionally executed load inside the loop. */
export function bytesHeaderAlias(host: LlvmEmitterContext): string {
  const tag = host.memoryAliasAttachment("bytes:header");
  return tag === "" ? "" : `${tag}, !invariant.load !{}`;
}

/** A header load whose value the program reads (`length`, `byteLength`)
 * keeps the alias tag only. The value can outlive the view, and LLVM may
 * move an invariant load to its use, past the release that frees the
 * view. */
export function bytesHeaderValueAlias(host: LlvmEmitterContext): string {
  return host.memoryAliasAttachment("bytes:header");
}

/** Element storage's tag, and the alias scope of the access being emitted
 * in a loop version's fast copy (bytesAccessScope). */
export function bytesElementAlias(host: LlvmEmitterContext): string {
  return host.memoryAliasAttachment("bytes:elements") + host.bytesAccessScope;
}

/** A module global's slot is its own category for whole-slot loads of a
 * scalar or typed-array binding. Stores stay untagged (and so alias it). */
export function globalSlotAlias(host: LlvmEmitterContext, id: string, type: string): string {
  return type === "bytes" || type === "f64" ? host.memoryAliasAttachment(`global:${id}`) : "";
}
