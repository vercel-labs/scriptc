;; tests/corpus/webassembly-dylink: the main module of a dynamically linked
;; program, shaped like quickjs-wasi's quickjs.wasm: it exports its memory,
;; its function table, __stack_pointer, malloc and the entry points an
;; extension's init function calls.
(module
  (type $i_i (func (param i32) (result i32)))
  (memory (export "memory") 2)
  (table (export "__indirect_function_table") 4 funcref)
  (global $sp (export "__stack_pointer") (mut i32) (i32.const 65536))
  (global $heap (mut i32) (i32.const 1024))
  (global $registered (mut i32) (i32.const 0))
  (func (export "malloc") (param i32) (result i32)
    (local i32)
    (local.set 1 (global.get $heap))
    (global.set $heap
      (i32.and (i32.add (i32.add (global.get $heap) (local.get 0)) (i32.const 15)) (i32.const -16)))
    (local.get 1))
  (func (export "qjs_get_context_ptr") (result i32) (i32.const 100))
  (func (export "qjs_get_runtime_ptr") (result i32) (i32.const 200))
  ;; js_register(ctx, tableIndex): remembers a function an extension adds.
  (func (export "js_register") (param i32 i32) (result i32)
    (i32.store
      (i32.add (i32.const 512) (i32.mul (global.get $registered) (i32.const 4)))
      (local.get 1))
    (global.set $registered (i32.add (global.get $registered) (i32.const 1)))
    (global.get $registered))
  ;; js_call(n, x): calls the n-th registered function through the table.
  (func (export "js_call") (param i32 i32) (result i32)
    (call_indirect (type $i_i)
      (local.get 1)
      (i32.load (i32.add (i32.const 512) (i32.mul (local.get 0) (i32.const 4))))))
  (func (export "helper") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1000)))
)
