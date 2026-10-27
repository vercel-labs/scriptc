;; tests/corpus/webassembly-dylink: an extension shaped like quickjs-wasi's
;; WebAssembly shared libraries (wasi-sdk -shared): it shares the main
;; module's memory and table, places its data and functions at the
;; __memory_base and __table_base the loader assigns, reaches the main
;; module through GOT.mem and GOT.func globals and env imports, and leaves
;; one symbol unresolved and one resolved by its own export. The program's
;; base64 copy appends the dylink.0 section: memory size 48 (alignment 2^2),
;; table size 2, needed "libc.so".
(module
  (type $i_i (func (param i32) (result i32)))
  (import "env" "memory" (memory 1))
  (import "env" "__indirect_function_table" (table 0 funcref))
  (import "env" "__stack_pointer" (global $sp (mut i32)))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "GOT.mem" "counter" (global $got_counter (mut i32)))
  (import "GOT.func" "helper" (global $got_helper (mut i32)))
  (import "env" "js_register" (func $js_register (param i32 i32) (result i32)))
  (import "env" "missing_symbol" (func $missing (param i32) (result i32)))
  (import "env" "self_symbol" (func $self (param i32) (result i32)))
  (data (global.get $mb) "name=demo\0aversion=1.2\00")
  (elem (global.get $tb) $triple $via_helper)
  (func $triple (type $i_i) (i32.mul (local.get 0) (i32.const 3)))
  (func $via_helper (type $i_i)
    (call_indirect (type $i_i) (local.get 0) (global.get $got_helper)))
  (func (export "__wasm_apply_data_relocs")
    (global.set $got_counter (i32.add (global.get $mb) (i32.const 32))))
  (func (export "__wasm_call_ctors")
    (i32.store (global.get $got_counter) (i32.const 5)))
  (func (export "qjs_ext_demo_init") (param i32 i32) (result i32)
    (drop (call $js_register (local.get 0) (global.get $tb)))
    (drop (call $js_register (local.get 0) (i32.add (global.get $tb) (i32.const 1))))
    (i32.sub (local.get 1) (i32.const 200)))
  (func (export "qjs_ext_demo_versions") (result i32) (global.get $mb))
  (func (export "self_symbol") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1)))
  (func (export "use_self") (param i32) (result i32) (call $self (local.get 0)))
  (func (export "use_missing") (param i32) (result i32) (call $missing (local.get 0)))
  (func (export "stack_pointer") (result i32) (global.get $sp))
  (func (export "bump_counter") (result i32)
    (i32.store (global.get $got_counter) (i32.add (i32.load (global.get $got_counter)) (i32.const 1)))
    (i32.load (global.get $got_counter)))
)
