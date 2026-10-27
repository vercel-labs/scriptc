;; tests/corpus/webassembly-jsapi.mjs: a module that defines and exports a
;; memory, a table and globals, exported twice each, for identity and for
;; importing what one instance exports into another.
(module
  (memory (export "mem") (export "mem2") 1 4)
  (table (export "tab") 2 8 funcref)
  (global (export "g") (export "g2") (mut i32) (i32.const 7))
  (global (export "fixed") f64 (f64.const 1.5))
  (func (export "id") (param i32) (result i32) (local.get 0))
  (elem (i32.const 1) 0)
)
