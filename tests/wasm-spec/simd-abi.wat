;; producer
(module
 (global $g (export "g") (mut v128) (v128.const i32x4 1 2 3 4))
 (global (export "constant") v128 (v128.const i32x4 5 6 7 8))
 (func (export "vector") (param i32 v128 i64 v128) (result v128 i32 v128 i64)
  local.get 1 local.get 0 local.get 3 local.get 2)
 (func (export "result") (result v128) i32.const 42 i32x4.splat global.set $g global.get $g)
 (func (export "high") (result i64) global.get $g i64x2.extract_lane 1)
 (func (export "get") (result i32) global.get $g i32x4.extract_lane 3)
 (func (export "set") i32.const 99 i32x4.splat global.set $g)
 (table (export "table") 1 funcref)
 (elem (i32.const 0) 0))

;; consumer
(module
 (type $sig (func (param i32 v128 i64 v128) (result v128 i32 v128 i64)))
 (import "m" "vector" (func $vector (type $sig)))
 (import "m" "g" (global $g (mut v128)))
 (import "m" "constant" (global $c v128))
 (import "m" "table" (table 1 funcref))
 (func (export "run") (result i32) (local $i i32) (local $j i64) (local $v v128)
  i32.const 17 v128.const i32x4 10 20 30 40 i64.const 23 v128.const i32x4 50 60 70 80
  call $vector
  local.set $j local.set $v local.set $i i32x4.extract_lane 3
  local.get $i i32.add local.get $v i32x4.extract_lane 3 i32.add
  local.get $j i32.wrap_i64 i32.add global.get $g i32x4.extract_lane 3 i32.add
  global.get $c i32x4.extract_lane 3 i32.add)
 (func (export "indirect") (result i32) (local $i i32) (local $j i64) (local $v v128)
  i32.const 7 v128.const i32x4 1 2 3 4 i64.const 11 v128.const i32x4 5 6 7 8 i32.const 0
  call_indirect (type $sig)
  local.set $j local.set $v local.set $i i32x4.extract_lane 3
  local.get $i i32.add local.get $v i32x4.extract_lane 3 i32.add local.get $j i32.wrap_i64 i32.add)
 (func (export "set") v128.const i64x2 0 123456789 global.set $g)
 (export "again" (func $vector)))

;; jsImport
(module
 (import "m" "f" (func $f (param v128)))
 (func (export "run") v128.const i64x2 0 1 call $f))

;; jsResult
(module
 (import "m" "f" (func $f (result v128)))
 (func (export "run") call $f drop))
