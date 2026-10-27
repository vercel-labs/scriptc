/* The contract between translated WebAssembly modules and the runtime
 * (scr_wasm.c). The compiler's translator (packages/compiler/src/wasm/
 * translate.ts) emits each module's code, an init function and one
 * ScrWasmModuleDesc as LLVM IR in the program module, plus the registry
 * scr_wasm_registry listing every translated module. The runtime
 * implements the JavaScript API once, generically, over these
 * descriptors; it never sees the translator's own data structures, and
 * the translator never sees the runtime's.
 *
 * Every descriptor field is pointer- or 64-bit sized so the emitted LLVM
 * structs and these C structs have the same layout without padding rules.
 * Signatures are strings "params:results" over the letters i (i32),
 * I (i64), f (f32), F (f64), r (funcref) and x (externref). Values travel
 * in uint64_t slots: f32 and f64 as their bit patterns, references as
 * pointers (externref: a borrowed ScrDyn *, NULL for null; funcref: a
 * ScrWasmFuncRef *, NULL for null).
 *
 * Instance layout (the first argument of every translated function):
 *     0   ScrWasmInst *host            runtime state
 *     8   uint8_t *memory_base         memory 0's data
 *     16  ScrWasmMemory *memory        memory 0, or NULL
 *     24  ScrWasmFuncRef *funcrefs     one record per function
 *     32  ScrWasmTable *tables[table_count]
 *     ..  uint64_t *globals[global_count]   one cell per global
 * With guard pages (no SCR_WASM_DESC_BOUNDS_CHECKS) memory_base never
 * changes: the memory is reserved once at its largest size plus a guard
 * region, and grow only commits pages. With explicit bounds checks the
 * memory is reserved at its largest size without a guard region, so
 * memory_base does not change either where the host can reserve address
 * space; the translated code still reloads memory_base and the byte
 * length after every call. */
#ifndef SCR_WASM_ABI_H
#define SCR_WASM_ABI_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SCR_WASM_ABI_VERSION 2

enum { SCR_WASM_FUNC = 0, SCR_WASM_TABLE = 1, SCR_WASM_MEMORY = 2, SCR_WASM_GLOBAL = 3 };

/* Trap codes the translated code passes to scr_wasm_trap (translate.ts
 * TRAP_*), plus the runtime's own. */
enum {
  SCR_WASM_TRAP_NONE = 0,
  SCR_WASM_TRAP_UNREACHABLE = 1,
  SCR_WASM_TRAP_MEMORY_OOB = 2,
  SCR_WASM_TRAP_DIV_BY_ZERO = 3,
  SCR_WASM_TRAP_DIV_UNREPRESENTABLE = 4,
  SCR_WASM_TRAP_REM_BY_ZERO = 5,
  SCR_WASM_TRAP_FLOAT_UNREPRESENTABLE = 6,
  SCR_WASM_TRAP_TABLE_OOB = 7,
  SCR_WASM_TRAP_SIGNATURE = 8,
  SCR_WASM_TRAP_NULL = 9,
  SCR_WASM_TRAP_ELEM_SEGMENT = 10,
  /* Runtime-only codes. */
  SCR_WASM_TRAP_EXHAUSTION = 100, /* RangeError: Maximum call stack size exceeded */
  SCR_WASM_TRAP_HOST = 101,       /* a JavaScript exception is pending */
  SCR_WASM_TRAP_DATA_SEGMENT = 102, /* instantiation: active data segment out of bounds */
};

/* Descriptor flags. */
#define SCR_WASM_DESC_BOUNDS_CHECKS 1u

typedef void (*ScrWasmThunk)(void *inst, const uint64_t *args, uint64_t *results);
/* A signature's call thunk: calls `code` (a function of that signature,
 * `(inst, params...) -> results`) with the arguments in slots. */
typedef void (*ScrWasmCallThunk)(void *code, void *inst, const uint64_t *args, uint64_t *results);

typedef struct {
  const char *module;
  uint64_t module_len;
  const char *name;
  uint64_t name_len;
  uint64_t kind;
  /* The index among imports of this kind (function imports: the function
   * index). */
  uint64_t index;
  /* Functions: the signature; tables: the element letter; globals: the
   * value letter; memories: "". */
  const char *type;
} ScrWasmImportDesc;

typedef struct {
  const char *name;
  uint64_t name_len;
  uint64_t kind;
  uint64_t index; /* function, table, memory or global index */
  const char *type;
  ScrWasmThunk call; /* functions */
} ScrWasmExportDesc;

typedef struct {
  uint64_t elem; /* 'r' or 'x' */
  uint64_t min;
  uint64_t max; /* UINT64_MAX when absent */
  uint64_t imported;
} ScrWasmTableDesc;

typedef struct {
  uint64_t type; /* signature letter */
  uint64_t mutable_;
  uint64_t imported;
} ScrWasmGlobalDesc;

typedef struct {
  const uint8_t *data;
  uint64_t len;
} ScrWasmDataDesc;

/* An element segment: per item a function index, -1 for null, or
 * -(2 + g) for the value of global g. */
typedef struct {
  uint64_t elem;
  uint64_t count;
  const int64_t *items;
} ScrWasmElemDesc;

/* A custom section: its name and payload, in module order. Only programs
 * that call WebAssembly.Module.customSections carry them (the translator
 * emits none otherwise, so debug sections cost nothing). */
typedef struct {
  const char *name;
  uint64_t name_len;
  const uint8_t *data;
  uint64_t len;
} ScrWasmCustomDesc;

typedef struct ScrWasmModuleDesc {
  uint8_t sha256[32];
  uint64_t byte_length;
  uint64_t abi_version;
  uint64_t flags;
  uint64_t import_count;
  const ScrWasmImportDesc *imports;
  uint64_t export_count;
  const ScrWasmExportDesc *exports;
  uint64_t func_count; /* imported + defined */
  uint64_t imported_func_count;
  /* Per function: the native code `(inst, params...) -> results` for
   * functions a reference can name (NULL otherwise), the canonical
   * signature identity call_indirect compares, and the signature text. */
  void *const *func_codes;
  const uint64_t *func_types;
  const char *const *func_sigs;
  uint64_t table_count;
  const ScrWasmTableDesc *tables;
  uint64_t memory_count; /* 0 or 1 */
  uint64_t memory_min;   /* pages */
  uint64_t memory_max;   /* pages, UINT64_MAX when absent */
  uint64_t global_count;
  const ScrWasmGlobalDesc *globals;
  uint64_t data_count;
  const ScrWasmDataDesc *datas;
  uint64_t elem_count;
  const ScrWasmElemDesc *elems;
  /* Globals, table initializers and active segments, under the trap
   * guard; then the start function `void (inst)`, or NULL. */
  void (*init)(void *inst);
  void (*start)(void *inst);
  uint64_t custom_count;
  const ScrWasmCustomDesc *customs;
  /* Per function: the call thunk of its signature for referenced
   * functions the module does not export (NULL otherwise), so any
   * function reference can be called from JavaScript. */
  const ScrWasmCallThunk *func_call_thunks;
} ScrWasmModuleDesc;

/* The registry the compiler emits in the program module of every program
 * that uses the WebAssembly API (count may be 0). */
typedef struct {
  uint64_t count;
  const ScrWasmModuleDesc *const *modules;
} ScrWasmRegistry;
extern const ScrWasmRegistry scr_wasm_registry;

/* The modules the build saw but does not translate, emitted next to the
 * registry: unsupported proposals, invalid modules and translator
 * limits. `reason` is a clause naming why (not NUL-terminated). */
typedef struct {
  uint8_t sha256[32];
  uint64_t byte_length;
  const char *reason;
  uint64_t reason_len;
} ScrWasmUntranslatedDesc;

typedef struct {
  uint64_t count;
  const ScrWasmUntranslatedDesc *modules;
} ScrWasmUntranslatedTable;
extern const ScrWasmUntranslatedTable scr_wasm_untranslated;

/* Runtime objects the translated code reads at fixed offsets. */
typedef struct ScrWasmMemory {
  uint8_t *base;      /* 0 */
  uint64_t size;      /* 8: bytes */
  uint64_t max_pages; /* 16 */
  uint64_t reserved;  /* 24: bytes of address space reserved at base */
  size_t rc;
  bool guarded;
  struct ScrDyn *buffer; /* the cached ArrayBuffer */
  uint64_t buffer_size;  /* the size it was created at */
  uint64_t declared_max; /* pages; UINT64_MAX when the memory has no maximum */
  bool buffer_exposed;   /* a buffer over the storage was handed out */
  /* The byte stores of every ArrayBuffer handed out over this memory's
   * storage (retained). The storage outlives the memory while JavaScript
   * still holds one of them or a view over it. */
  struct ScrBytes **exposed;
  size_t exposed_count;
  struct ScrWasmMemory *next_parked; /* released, storage still exposed */
} ScrWasmMemory;

typedef struct ScrWasmFuncRef {
  void *code;    /* 0 */
  uint64_t type; /* 8 */
  void *inst;    /* 16: the instance the code expects; its host and the
                  * record's position in its funcrefs name the function */
} ScrWasmFuncRef;

typedef struct ScrWasmTable {
  void **elems;  /* 0: ScrWasmFuncRef * or ScrDyn * (retained) */
  uint32_t size; /* 8 */
  uint32_t max;
  size_t rc;
  char elem; /* 'r' or 'x' */
  uint64_t declared_max; /* UINT64_MAX when the table has no maximum */
} ScrWasmTable;

/* A global's cell: the value in the low bytes of `value`. */
typedef struct ScrWasmGlobal {
  uint64_t value; /* 0 */
  size_t rc;
  char type;
  bool mutable_;
} ScrWasmGlobal;

#endif
