/* The generated side of the library host-callback state — scr_core.h's
 * ScrLibHostState object. A native host-call site owns its channel's slot
 * constant at compile time (the profile caps channels at
 * SCR_LIB_MAX_CALLBACKS, and the profile validator proves every slot in
 * range), so it addresses the channel's registered fn, its opaque ctx, and
 * the callback-depth counter at constant offsets through the one exported
 * object: one TLS base access for the fields a call needs instead of a
 * call to each accessor. scr_library.c's static assertions pin the offsets
 * this type mirrors; lib-host-state.test.ts reads the capacity from the
 * header. */

/** The runtime's fixed channel-slot capacity (scr_core.h's
 * SCR_LIB_MAX_CALLBACKS — keep the two in step). */
export const SCR_LIB_MAX_CALLBACKS = 32;

/** `%ScrLibHostState`: `fns`, `ctxs`, `depth`, in scr_core.h's declaration
 * order. `sizeType` is the target's size_t (the depth field). */
export function libHostStateType(sizeType: string): string {
  return `%ScrLibHostState = type { [${SCR_LIB_MAX_CALLBACKS} x ptr], [${SCR_LIB_MAX_CALLBACKS} x ptr], ${sizeType} }`;
}

/** The state object's declaration. SCR_TL makes the archive's copy
 * thread-local exactly when the library is thread-instanced
 * (abi.instance_per_thread); every other library carries one process-wide
 * copy. */
export function libHostStateDecl(threadInstances: boolean): string {
  return `@scr_library_host_state = external ${threadInstances ? "thread_local " : ""}global %ScrLibHostState`;
}
