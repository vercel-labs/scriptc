/* scriptc runtime — ES Symbol values (scr_symbol.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_SYMBOL_H
#define SCR_SYMBOL_H

#include "scr_string.h"

/* ── ES Symbol values (scr_symbol.c — linked only when the IR uses the
 * symbol surface) ─────────────────────────────────────────────────────
 * A symbol is a runtime-unique IDENTITY: the pointer IS the identity
 * (`===` is a pointer compare; every scr_sym_new allocation is a distinct
 * symbol even for equal descriptions — JS exactly). Heap, refcounted,
 * IMMUTABLE; holds at most two strings (description + registry key), so
 * never part of a cycle, no trace. Symbol.for's global registry interns
 * per KEY (byte equality) and is spec-permanent — entries are never
 * evicted; an atexit cleanup (registered at first use, so LIFO runs it
 * BEFORE scr_init's RC audit) releases the chain so audited string counts
 * stay exact. None of these throw. */
typedef struct ScrSym ScrSym;

ScrSym *scr_sym_new(ScrStr *desc); /* borrows desc (NULL = no description); +1 fresh identity */
ScrSym *scr_sym_for(ScrStr *key);  /* borrows key; +1 on the interned per-key symbol */
ScrSym *scr_sym_retain(ScrSym *s);
void scr_sym_release(ScrSym *s);
void *scr_sym_retain_v(void *p);
void scr_sym_release_v(void *p);
ScrStr *scr_sym_desc(ScrSym *s);      /* +1 description, or NULL when absent */
ScrStr *scr_sym_key_for(ScrSym *s);   /* +1 registry key, or NULL (not registered) */
ScrStr *scr_sym_to_string(ScrSym *s); /* +1 "Symbol(desc)" ("Symbol()" when absent) */

/* A Dirent row's dyn object (the record converter has set name,
 * parentPath and %dtype): sets the Dirent prototype with the type probes,
 * adds the Symbol(type) key and makes %dtype non-enumerable. The compiler
 * links this unit whenever the program has the Dirent record shape. */
typedef struct ScrDyn ScrDyn; /* full definition in scr_dyn.h (C11 repeat) */
void scr_dyn_dirent_finish(ScrDyn *obj);

/* A symbol event name's registry key is a ScrStr-shaped identity key
 * (scr_str_symbol_key in scr_string.h). The emitter's symbol-keyed
 * buckets reach this unit through scr_sym_event_ops, the table this unit
 * installs from a constructor — scr_string.h declares it beside the key.
 */

#endif /* SCR_SYMBOL_H */
