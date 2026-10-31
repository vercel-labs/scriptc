/* scriptc runtime — Headers iteration (scr_fetch_headers_walk.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_FETCH_HEADERS_WALK_H
#define SCR_FETCH_HEADERS_WALK_H

#include "scr_dyn.h"

/* ── `for..of` over a static Headers' entries()/keys()/values()
 * (scr_fetch_headers_walk.c — a unit of its own, selected only by programs
 * that iterate a Headers: adding these functions to scr_fetch.c changes
 * that unit's object for every fetch program). Both entries read the
 * fetch unit's OWN live list by index (scr_fetch.c's iter_count/iter_at
 * hooks, the same entries its iterator steps), so a body that appends,
 * sets or deletes headers visits exactly what Node's live iterator
 * visits, at one O(1) read per entry. */
double scr_fetch_headers_count(ScrDyn *headers);
ScrStr *scr_fetch_headers_entry(ScrDyn *headers, double index, double part); /* +1 */

#endif
