/* The declaration-typed boundary's adoption, linked only by programs with
 * boundary casts (runtime feature declAdopt).
 *
 * A boundary cast (decl-projection.ts in the compiler) checks a value
 * package code produced against the type the package's declarations give
 * it and builds the native value. Copying would be observable whenever
 * something else still references a source object or array, so this pass
 * walks the source next to a live capsule of the built value and turns
 * every source node with another holder (rc above one) into a live
 * capsule of the native value built from it: every holder then reads and
 * writes the same native value. Unshared nodes are left to be released
 * with their parent, which no program can tell apart from a move.
 *
 * Phase one checks that every converted node is plain data (the native
 * value has no prototype, accessors, symbol keys or frozen state) and
 * collects the shared ones; it throws the path TypeError before anything
 * changes. Phase two converts the shared nodes in place
 * (scr_dyn_decl_become, scr_json.c).
 *
 * Every other checked cast of a dynamic value to a record or array runs the
 * same pass leniently (scr_dyn_adopt_shared): a node that cannot become a
 * capsule keeps the cast's copy.
 *
 * A conversion without an assertion (an annotated binding, a typed
 * parameter, a stored field or element, a returned value) runs it whole
 * (scr_dyn_adopt_whole): every object the value holds becomes one object
 * with the one built in its place, or nothing changes and the conversion
 * stays the copy it was. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

void scr_dyn_decl_become(ScrDyn *n, const ScrDyn *capsule);

typedef struct {
  ScrDyn *node;
  ScrDyn *capsule; /* owned */
} ScrDeclAdopt;

typedef struct {
  ScrDeclAdopt *items;
  size_t len, cap;
  /* A checked cast outside the boundary (scr_dyn_adopt_shared): a node
   * that cannot become a capsule keeps the copy instead of throwing. */
  bool lenient;
  /* A conversion without an assertion (scr_dyn_adopt_whole): all of the
   * value or none of it. A parent that became a capsule while one of its
   * children kept the copy would hold that copy in the child's place, and
   * the source's other names would read another object than before: the
   * same object stored twice would be two, an accessor or a symbol key
   * would be gone. So any child the walk cannot make one object with the
   * built one in its place ends the walk, and nothing is adopted. */
  bool whole;
} ScrDeclAdoptList;

static void scr_decl_adopt_push(ScrDeclAdoptList *list, ScrDyn *node, ScrDyn *capsule) {
  if (list->len == list->cap) {
    list->cap = list->cap ? list->cap * 2 : 8;
    list->items = realloc(list->items, list->cap * sizeof *list->items);
    if (!list->items) scr_trap("scriptc: out of memory\n");
  }
  list->items[list->len].node = node;
  list->items[list->len].capsule = capsule;
  list->len++;
}

/* Whether the value built from a node holds a view of its source: the one
 * place a record has for a property attribute its layout cannot carry
 * (scr_record_source_note keeps a source for a non-enumerable declared
 * key). A layout without one, such as an index-signature record, which
 * captures undeclared keys into a map that holds no attributes, would list
 * such a key as an ordinary one. */
static bool scr_decl_adopt_keeps_attributes(const ScrDyn *capsule) {
  return capsule->kind == SCR_DYN_TYPED_REF && scr_record_source_has(capsule->v.typed_ref.ptr);
}

static bool scr_decl_adopt_plain(const ScrDyn *n, const ScrDyn *capsule, const ScrDynPath *path,
                                 bool lenient) {
  const char *want = NULL;
  if (n->kind == SCR_DYN_OBJ) {
    if (n->prototype || n->null_proto || n->v.obj.class_name)
      want = "a plain object (this value has a prototype)";
    else if (n->symbol_properties || n->symbol_keys)
      want = "a plain object (this value has symbol-keyed properties)";
    else if (n->non_extensible)
      want = "a plain object (this value is frozen, sealed or not extensible)";
    else if (n->v.obj.source_access && !n->v.obj.source_identity)
      want = "a plain object";
    else {
      const bool keeps_attributes = scr_decl_adopt_keeps_attributes(capsule);
      for (size_t i = 0; i < scr_dyn_obj_count(n) && !want; i++) {
        ScrDynProp e = scr_dyn_obj_prop_at(n, i);
        /* A non-enumerable data property stays one only where the built
         * record keeps a view of its source; a read-only or
         * non-configurable one has no native form yet. */
        if (e.accessor) want = "a plain object (this value has accessor properties)";
        else if (!e.writable || !e.configurable)
          want = "a plain object (this value has read-only or non-configurable properties)";
        else if (!e.enumerable && !keeps_attributes)
          want = "a plain object (this value has a non-enumerable key its record type cannot keep)";
      }
    }
  } else if (n->kind == SCR_DYN_ARR) {
    if (n->prototype)
      want = "a plain array (this value has a prototype)";
    else if (n->v.arr.properties || n->symbol_properties || n->symbol_keys)
      want = "a plain array (this value has extra properties)";
    else if (n->v.arr.sealed || n->v.arr.frozen || n->non_extensible)
      want = "a plain array (this value is frozen, sealed or not extensible)";
  }
  if (!want) return true;
  if (!lenient) scr_dyn_check_fail(path, want, n);
  return false;
}

static ScrDyn *scr_decl_capsule_ptr_holder(const ScrDeclAdoptList *list, const ScrDyn *node) {
  for (size_t i = 0; i < list->len; i++)
    if (list->items[i].node == node) return list->items[i].capsule;
  return NULL;
}

/* Whether the walk follows a child: plain objects and arrays. A boxed
 * native record or array is already one object with its native value; a
 * cast to another layout copies it (the copy keeps a cached identity per
 * capsule, scr_dyn_typed_ref_cache_cast). */
static bool scr_decl_adopt_follows(const ScrDyn *child) {
  return child && (child->kind == SCR_DYN_OBJ || child->kind == SCR_DYN_ARR);
}

/* Whether `===` tells a value from a copy of it: anything but a primitive. */
static bool scr_decl_adopt_identity(const ScrDyn *child) {
  if (!child) return false;
  switch (child->kind) {
  case SCR_DYN_NULL:
  case SCR_DYN_UNDEF:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    return false;
  default:
    return true;
  }
}

/* In a whole adoption, whether a child the walk does not follow (a
 * function, a class instance, a boxed native value) is the object the built
 * value holds in its place. `built` is owned. */
static bool scr_decl_adopt_kept(const ScrDyn *child, ScrDyn *built) {
  bool same = built && scr_dyn_strict_eq(child, built);
  scr_dyn_release(built);
  return same;
}

/* `capsule` is owned by the call: pushed or released. */
static bool scr_decl_adopt_walk(ScrDeclAdoptList *list, ScrDyn *n, ScrDyn *capsule,
                                const ScrDynPath *path, unsigned depth) {
  if (!n || (n->kind != SCR_DYN_OBJ && n->kind != SCR_DYN_ARR) || !capsule ||
      capsule->kind != SCR_DYN_TYPED_REF || capsule == n || depth > 4096) {
    /* Nothing to adopt. A whole adoption goes on only where the built value
     * holds the node itself. */
    bool kept = !list->whole || !n || (n->kind != SCR_DYN_OBJ && n->kind != SCR_DYN_ARR) || capsule == n;
    scr_dyn_release(capsule);
    return kept;
  }
  if (!scr_decl_adopt_plain(n, capsule, path, list->lenient)) {
    scr_dyn_release(capsule);
    return list->lenient && !list->whole;
  }
  if (list->whole && n->rc == SIZE_MAX) {
    /* A node that is never converted in place. */
    scr_dyn_release(capsule);
    return false;
  }
  if (n->rc > 1 && n->rc != SIZE_MAX) {
    ScrDyn *seen = scr_decl_capsule_ptr_holder(list, n);
    if (seen) {
      bool same = seen->v.typed_ref.ptr == capsule->v.typed_ref.ptr;
      scr_dyn_release(capsule);
      if (!same && list->whole) return false;
      if (!same && list->lenient) return true;
      if (!same)
        scr_dyn_check_fail(path, "a value that is not also stored elsewhere in this value (scriptc builds a separate native copy for each place)", n);
      return same;
    }
    scr_decl_adopt_push(list, n, capsule);
  }
  void *ptr = capsule->v.typed_ref.ptr;
  if (capsule->v.typed_ref.record && capsule->v.typed_ref.array && n->kind == SCR_DYN_OBJ) {
    const ScrDynTypedRecordOps *ops = (const ScrDynTypedRecordOps *)(const void *)capsule->v.typed_ref.array;
    size_t paired = 0;
    for (size_t i = 0; i < ops->count; i++) {
      if (!ops->has(ptr, i)) continue;
      const ScrStr *name = ops->names[i];
      ScrDyn *child = scr_dyn_obj_get(n, name->data, name->len);
      if (!scr_decl_adopt_follows(child)) {
        if (!list->whole || !scr_decl_adopt_identity(child)) continue;
        if (!scr_decl_adopt_kept(child, ops->get(ptr, i))) {
          if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
          return false;
        }
        paired++;
        continue;
      }
      paired++;
      ScrDynPath p = { path, name->data, 0 };
      if (!scr_decl_adopt_walk(list, child, ops->get(ptr, i), &p, depth + 1)) {
        if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
        return false;
      }
    }
    if (list->whole && !scr_record_source_view(ptr)) {
      /* An object under a key the record has no field for: only a record
       * with a view of its source holds it as it is (an index signature's
       * map holds a copy). */
      size_t held = 0;
      for (size_t i = 0; i < scr_dyn_obj_count(n); i++)
        if (scr_decl_adopt_identity(scr_dyn_obj_value_at(n, i))) held++;
      if (held > paired) {
        if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
        return false;
      }
    }
  } else if (!capsule->v.typed_ref.record && !capsule->v.typed_ref.klass && !capsule->v.typed_ref.array &&
             n->kind == SCR_DYN_ARR && !n->v.arr.presence) {
    /* A capsule without element hooks over an array: a tuple, whose index
     * field names get no record hooks. Its view holds a live capsule of
     * each record or array element, which the source element adopts (the
     * walk skips the other elements). */
    ScrDyn *view = capsule->v.typed_ref.materialize(ptr);
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
      return false;
    }
    if (list->whole && !(view && view->kind == SCR_DYN_ARR && view->v.arr.len == n->v.arr.len)) {
      scr_dyn_release(view);
      if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
      return false;
    }
    if (view && view->kind == SCR_DYN_ARR) {
      size_t len = n->v.arr.len < view->v.arr.len ? n->v.arr.len : view->v.arr.len;
      for (size_t i = 0; i < len; i++) {
        ScrDyn *child = n->v.arr.items[i], *element = view->v.arr.items[i];
        if (!element || !scr_decl_adopt_follows(child)) {
          if (!list->whole || !scr_decl_adopt_identity(child)) continue;
          if (element && scr_dyn_strict_eq(child, element)) continue;
          scr_dyn_release(view);
          if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
          return false;
        }
        ScrDynPath p = { path, NULL, i };
        if (!scr_decl_adopt_walk(list, child, scr_dyn_retain(element), &p, depth + 1)) {
          scr_dyn_release(view);
          if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
          return false;
        }
      }
    }
    scr_dyn_release(view);
  } else if (!capsule->v.typed_ref.record && !capsule->v.typed_ref.klass &&
             capsule->v.typed_ref.array && n->kind == SCR_DYN_ARR && !n->v.arr.presence) {
    const ScrDynTypedArrayOps *ops = capsule->v.typed_ref.array;
    for (size_t i = 0; i < n->v.arr.len; i++) {
      ScrDyn *child = n->v.arr.items[i];
      if (!scr_decl_adopt_follows(child)) {
        if (!list->whole || !scr_decl_adopt_identity(child)) continue;
        if (scr_decl_adopt_kept(child, ops->get(ptr, (double)i))) continue;
        if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
        return false;
      }
      ScrDynPath p = { path, NULL, i };
      if (!scr_decl_adopt_walk(list, child, ops->get(ptr, (double)i), &p, depth + 1)) {
        if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
        return false;
      }
    }
  } else if (list->whole) {
    /* A shape whose children the walk cannot pair with the built value's (a
     * sparse array, a capsule without element or field hooks). */
    if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
    return false;
  }
  if (!(n->rc > 1 && n->rc != SIZE_MAX)) scr_dyn_release(capsule);
  return true;
}

static void scr_decl_adopt_run(ScrDyn *source, ScrDyn *capsule, bool lenient, bool whole) {
  ScrDeclAdoptList list = { NULL, 0, 0, lenient, whole };
  bool ok = scr_decl_adopt_walk(&list, source, scr_dyn_retain(capsule), NULL, 0);
  for (size_t i = 0; i < list.len; i++) {
    ScrDeclAdopt *item = &list.items[i];
    if (ok && item->node->kind != SCR_DYN_TYPED_REF) scr_dyn_decl_become(item->node, item->capsule);
    scr_dyn_release(item->capsule);
  }
  free(list.items);
}

void scr_dyn_decl_adopt(ScrDyn *source, ScrDyn *capsule) {
  scr_decl_adopt_run(source, capsule, false, false);
}

/* Any other checked cast of a dynamic value to a record or array
 * (`value as T`): the same adoption, so a source that something else still
 * holds keeps one identity with the built value. A node that is not plain
 * data, or that the value holds in two places, keeps the separate copy the
 * cast built (the conversion already succeeded; nothing throws here). */
void scr_dyn_adopt_shared(ScrDyn *source, ScrDyn *capsule) {
  scr_decl_adopt_run(source, capsule, true, false);
}

/* A checked conversion without an assertion, where a typed slot takes a
 * dynamic value (the compiler's dynCheck.shared): the same adoption, whole.
 * Without it the conversion is a copy that leaves its source as it was, so
 * the adoption may only make the source and the built value one object in
 * every place: a value with a node that is not plain data, with the same
 * object in two places, with a sparse array, or with a child the built
 * value holds a copy of (a class instance in a record's slot, an index
 * signature's values) is left as it is, and the conversion stays the copy.
 * Nothing throws here. */
void scr_dyn_adopt_whole(ScrDyn *source, ScrDyn *capsule) {
  scr_decl_adopt_run(source, capsule, true, true);
}

/* Whether either adoption above can change anything for `source`: the walk
 * leaves at once for a value that is not a plain object or array (a capsule
 * of a native value, a primitive, a function). A cast asks before it boxes
 * its result for the call. */
bool scr_dyn_adoptable(const ScrDyn *source) {
  return source && (source->kind == SCR_DYN_OBJ || source->kind == SCR_DYN_ARR);
}
