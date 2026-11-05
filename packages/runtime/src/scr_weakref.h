/* WeakRef (scr_weakref.c): ECMAScript weak references over the native
 * heap's dispose observers, the same free-time notification the native
 * WeakMap and WeakSet use. The unit links only into a program that
 * constructs one (the weakRef runtime feature and `weakRef.new`), and the
 * observer arms in scr_json.c exist only in that program's build of the
 * unit (SCR_WEAK_REF), so every other program keeps the default object. */
#ifndef SCR_WEAKREF_H
#define SCR_WEAKREF_H

#include "scr_dyn.h"

/* The live cells in this thread's table. scr_json.c's dispose observers
 * test it before calling scr_weakref_disposed, so a program without a
 * WeakRef pays nothing for the arm. */
extern SCR_TL size_t scr_weakref_live;

/* A referent was freed: every WeakRef over it answers undefined from
 * deref() now. Callable with any address (a box, a record, a closure). */
void scr_weakref_disposed(void *key);

/* Installs the single dispose hook (scr_dispose_observers) that serves
 * weak collections, kept record sources and WeakRefs. scr_json.c owns the
 * function; the WeakRef unit asks for it on the first construction, the
 * same way a weak collection installs it. */
void scr_weakref_observers_install(void);

/* new WeakRef(target) (+1 handle box), or NULL with the exception pending:
 * Node's TypeError for a primitive, registered symbol or missing target,
 * and the SC2020 refusal for a native reference kind with no weak lifetime
 * contract. `target` is borrowed, as every libCall argument is: the kept
 * list takes its own reference and the caller keeps its own. */
ScrDyn *scr_weakref_new(ScrDyn *target);

/* deref() (+1): the target while the referent lives, else undefined. */
ScrDyn *scr_weakref_deref(ScrDyn *ref);

/* `value instanceof WeakRef`. */
bool scr_weakref_is(const ScrDyn *value);

#ifndef SCR_LIB
/* scr_weakref.test.c: the end of a job, without a microtask queue (the
 * clear job scr_queue_microtask would have run). Not a language surface. */
void scr_weakref_test_end_job(void);
#endif

#endif
