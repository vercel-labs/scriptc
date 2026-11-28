/* Entry points of runtime units a program may not link.
 *
 * A program links only the units its features need, so a unit that wants one
 * of these calls a table instead of the unit itself: the optional unit
 * installs its table from a constructor when it is linked (scr_optional.c
 * holds the NULL-initialized defaults), and the caller tests the pointer.
 *
 * No weak symbols are involved, which is the point: an undefined weak
 * reference is null on ELF but refuses to link on Mach-O, so a binding that
 * only tests for null cannot be written once for every object format. A table
 * pointer is an ordinary strong definition, and a unit that is not linked
 * simply never installs it. */
#ifndef SCR_OPTIONAL_H
#define SCR_OPTIONAL_H

#include <stdbool.h>

typedef struct ScrDyn ScrDyn;
typedef struct ScrStr ScrStr;

/* The event-target unit (scr_event_target.c): the abort-listener entry an
 * AbortSignal needs, which http.Agent.createConnection passes to the dial. */
typedef struct {
  ScrDyn *(*add_abort_listener)(ScrDyn *signal, ScrDyn *listener);
} ScrEventTargetOps;

/* The diagnostics-channel unit (scr_dc.c): the tracing entries node:test's
 * runner publishes through. `channel` answers the interned handle, `publish`
 * takes the message without consuming it, and `chan_has_subscribers` says
 * whether building a message is worth it. */
typedef struct {
  double (*channel)(ScrDyn *name);
  void (*publish)(double handle, ScrDyn *message);
  bool (*chan_has_subscribers)(double handle);
} ScrDcOps;

/* The inspect unit (scr_inspect.c): assert.ifError renders a non-error
 * value with util.inspect's defaults (compact, depth 2). */
typedef struct {
  ScrStr *(*dyn)(ScrDyn *d, double recurse, double depth);
} ScrInspectOps;

/* NULL until the unit that provides them is installed. */
extern const ScrEventTargetOps *scr_optional_event_target;
extern const ScrDcOps *scr_optional_dc;
extern const ScrInspectOps *scr_optional_inspect;

#endif
