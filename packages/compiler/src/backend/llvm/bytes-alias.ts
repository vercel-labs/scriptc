import type { LlvmEmitterContext } from "./expr-context.js";

/** Alias categories of typed-array storage. A ScrBytes header (length,
 * data pointer, shared backing) is fixed at construction and only ever
 * written by runtime code, never by emitted code. Element storage is one
 * category for every element type: views of different types may share a
 * buffer. Neither overlaps the other, a native field, array storage or a
 * module global's slot, so element stores leave header loads and global
 * receiver slots loop-invariant. Untagged accesses and calls still alias
 * every category. */
export function bytesHeaderAlias(host: LlvmEmitterContext): string {
  return host.memoryAliasAttachment("bytes:header");
}

export function bytesElementAlias(host: LlvmEmitterContext): string {
  return host.memoryAliasAttachment("bytes:elements");
}

/** A module global's slot is its own category for whole-slot loads of a
 * scalar or typed-array binding. Stores stay untagged (and so alias it). */
export function globalSlotAlias(host: LlvmEmitterContext, id: string, type: string): string {
  return type === "bytes" || type === "f64" ? host.memoryAliasAttachment(`global:${id}`) : "";
}
