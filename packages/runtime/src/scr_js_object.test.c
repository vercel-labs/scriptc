#include "scr_runtime.h"
#include "scr_js.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Mirrors scr_json.c's layout budgets. */
#define SHAPE_BUDGET ((size_t)1 << 16)
#define KEY_BYTES_BUDGET ((size_t)4 << 20)

/* The key_len-byte key that starts with the digits of `i`. */
static ScrStr *key_of(char *bytes, size_t key_len, size_t i) {
  memset(bytes, 'k', key_len);
  int n = snprintf(bytes, key_len + 1, "%zu", i);
  bytes[n] = 'k';
  return scr_str_new(bytes, key_len);
}

/* A one-entry object {key: n}. */
static ScrDyn *object_with(const ScrStr *key, double n) {
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, key->data, key->len, scr_dyn_new_num(n));
  return object;
}

/* Cache records have static storage, as the compiled sites' do: the reset
 * at exit clears every record that holds entries. Each check starts from
 * an empty record. */
static ScrJsIc load_ic;
static ScrJsIc store_ic;

/* Whether a load probe answers `object.key` and returns `n`. */
static bool probe_reads(ScrDyn *object, const ScrStr *key, double n) {
  ScrJsIc *ic = &load_ic;
  memset(ic, 0, sizeof *ic);
  ScrDyn *value = scr_js_load_probe(object, key, ic);
  if (!value) return false;
  assert(value->kind == SCR_DYN_NUM && value->v.num == n);
  scr_dyn_release(value);
  return true;
}

/* Objects with a new key each: the probes shape them until `budget` shapes
 * exist, and answer with a miss after that, while the objects stay
 * readable and earlier shapes keep serving. */
static void budget_bounds_shapes(size_t key_len, size_t budget) {
  char *bytes = malloc(key_len + 1);
  assert(bytes);
  size_t shaped = 0;
  for (size_t i = 0; i < budget + 64; i++) {
    ScrStr *key = key_of(bytes, key_len, i);
    ScrDyn *object = object_with(key, (double)i);
    if (probe_reads(object, key, (double)i)) {
      assert(shaped == i);
      shaped++;
    } else {
      /* Later probes of the object miss too; the generic read answers. */
      assert(!probe_reads(object, key, (double)i));
      ScrDyn *value = scr_dyn_obj_get(object, key->data, key->len);
      assert(value && value->kind == SCR_DYN_NUM && value->v.num == (double)i);
    }
    scr_str_release(key);
    scr_dyn_release(object);
  }
  /* Objects the earlier checks built hold a few layouts already. */
  assert(shaped <= budget && shaped + 64 > budget);

  /* A key sequence shaped before the budget ran out. */
  ScrStr *first = key_of(bytes, key_len, 0);
  ScrDyn *object = object_with(first, 7);
  assert(probe_reads(object, first, 7));

  /* A store probe that would add a new shape leaves the add to the generic
   * store; one that replaces through an existing shape still runs. */
  memset(&store_ic, 0, sizeof store_ic);
  ScrStr *added = key_of(bytes, key_len, budget + 1000);
  ScrDyn *value = scr_dyn_new_num(8);
  assert(!scr_js_store_probe(object, added, value, &store_ic));
  assert(object->v.obj.len == 1);
  memset(&store_ic, 0, sizeof store_ic);
  assert(scr_js_store_probe(object, first, value, &store_ic));
  assert(probe_reads(object, first, 8));
  scr_dyn_release(value);
  scr_str_release(added);
  scr_str_release(first);
  scr_dyn_release(object);
  free(bytes);
}

/* Immortal objects (published graphs, shared by pointer across threads)
 * stay unshaped: probes miss, and nothing writes the shape word. */
static void immortal_objects_stay_unshaped(void) {
  ScrStr *key = scr_str_new("kept", 4);
  ScrDyn *object = object_with(key, 3);
  object->rc = SIZE_MAX;
  assert(!probe_reads(object, key, 3));
  assert(object->v.obj.len == 1);
  memset(&store_ic, 0, sizeof store_ic);
  ScrDyn *value = scr_dyn_new_num(4);
  assert(!scr_js_store_probe(object, key, value, &store_ic));
  assert(object->v.obj.len == 1);
  scr_dyn_release(value);
  scr_str_release(key);
}

/* A read site's probe answers a key that the receiver and its plain
 * prototype chain lack with undefined, and caches that answer until the
 * receiver's keys, its prototype, or the prototype's keys change. */
static ScrJsIc get_ic;
static ScrJsIc other_ic;

/* Each site reads one key, so each key below has its own record. */
static bool get_reads_undefined_at(ScrJsIc *ic, ScrDyn *object, const ScrStr *key) {
  ScrDyn *value = scr_js_get_probe(object, key, ic);
  if (!value) return false;
  assert(value->kind == SCR_DYN_UNDEF);
  scr_dyn_release(value);
  return true;
}

static bool get_reads_undefined(ScrDyn *object, const ScrStr *key) {
  ScrDyn *value = scr_js_get_probe(object, key, &get_ic);
  if (!value) return false;
  assert(value->kind == SCR_DYN_UNDEF);
  scr_dyn_release(value);
  return true;
}

static bool get_reads(ScrDyn *object, const ScrStr *key, double n) {
  ScrDyn *value = scr_js_get_probe(object, key, &get_ic);
  if (!value) return false;
  assert(value->kind == SCR_DYN_NUM && value->v.num == n);
  scr_dyn_release(value);
  return true;
}

static void absent_reads(void) {
  ScrStr *own = scr_str_new("own", 3);
  ScrStr *missing = scr_str_new("missing", 7);
  ScrStr *inherited = scr_str_new("toString", 8);

  /* No prototype: undefined, from the cache the second time. */
  ScrDyn *object = object_with(own, 1);
  memset(&get_ic, 0, sizeof get_ic);
  assert(get_reads_undefined(object, missing));
  assert(get_ic.count == 1);
  assert(get_reads_undefined(object, missing));
  assert(get_ic.count == 1);
  /* Method reads and Object.prototype member names keep the slow path. */
  memset(&load_ic, 0, sizeof load_ic);
  assert(!scr_js_load_probe(object, missing, &load_ic));
  memset(&other_ic, 0, sizeof other_ic);
  assert(!get_reads_undefined_at(&other_ic, object, inherited));
  /* The key added: the same record answers its value. */
  scr_dyn_obj_set(object, missing->data, missing->len, scr_dyn_new_num(2));
  assert(get_reads(object, missing, 2));

  /* One plain prototype that lacks the key, then gains it. */
  ScrDyn *prototype = object_with(own, 5);
  ScrDyn *child = object_with(own, 6);
  child->prototype = scr_dyn_retain(prototype);
  memset(&get_ic, 0, sizeof get_ic);
  assert(get_reads_undefined(child, missing));
  assert(get_reads_undefined(child, missing));
  scr_dyn_obj_set(prototype, missing->data, missing->len, scr_dyn_new_num(3));
  assert(get_reads(child, missing, 3));

  /* A receiver of the same shape with another prototype that lacks the
   * key: both answers stay cached. */
  ScrDyn *other_prototype = object_with(own, 7);
  ScrDyn *sibling = object_with(own, 8);
  sibling->prototype = scr_dyn_retain(other_prototype);
  assert(get_reads_undefined(sibling, missing));
  assert(get_reads(child, missing, 3));
  assert(get_reads_undefined(sibling, missing));

  /* A longer chain is left to the generic read, even for a receiver whose
   * absent answer was cached. */
  ScrDyn *grandparent = object_with(own, 9);
  other_prototype->prototype = scr_dyn_retain(grandparent);
  assert(!get_reads_undefined(sibling, missing));

  /* A prototype swapped on a cached receiver: the entry no longer holds. */
  ScrDyn *plain = object_with(own, 10);
  memset(&get_ic, 0, sizeof get_ic);
  assert(get_reads_undefined(plain, missing));
  plain->prototype = scr_dyn_retain(prototype);
  assert(get_reads(plain, missing, 3));

  /* More shapes than the record holds: the shared cache answers the reads
   * that the full record misses, absent keys included. */
  memset(&get_ic, 0, sizeof get_ic);
  memset(&other_ic, 0, sizeof other_ic);
  ScrDyn *shapes[SCR_JS_IC_WAYS + 3];
  char name[16];
  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++) {
    int n = snprintf(name, sizeof name, "k%zu", i);
    shapes[i] = object_with(own, (double)i);
    scr_dyn_obj_set(shapes[i], name, (size_t)n, scr_dyn_new_num((double)i));
  }
  for (int round = 0; round < 3; round++)
    for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++) {
      assert(get_reads(shapes[i], own, (double)i));
      assert(get_reads_undefined_at(&other_ic, shapes[i], missing));
    }
  for (size_t i = 0; i < sizeof shapes / sizeof shapes[0]; i++) scr_dyn_release(shapes[i]);

  scr_dyn_release(plain);
  scr_dyn_release(sibling);
  scr_dyn_release(other_prototype);
  scr_dyn_release(grandparent);
  scr_dyn_release(child);
  scr_dyn_release(prototype);
  scr_dyn_release(object);
  scr_str_release(inherited);
  scr_str_release(missing);
  scr_str_release(own);
}

int main(int argc, char **argv) {
  scr_init();
  /* Shapes count against the budget, so these checks run on their own. */
  if (argc > 1 && strcmp(argv[1], "absent") == 0) {
    absent_reads();
    puts("absent read checks passed");
    return 0;
  }
  immortal_objects_stay_unshaped();
  if (argc > 1 && strcmp(argv[1], "key-bytes") == 0) {
    /* 64 KiB keys spend the key-byte budget after 64 shapes. */
    size_t key_len = (size_t)64 << 10;
    budget_bounds_shapes(key_len, KEY_BYTES_BUDGET / key_len);
  } else {
    budget_bounds_shapes(8, SHAPE_BUDGET);
  }
  puts("shape budget checks passed");
  return 0;
}
