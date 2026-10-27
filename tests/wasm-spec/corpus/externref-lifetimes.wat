(module
  (import "env" "make" (func $make (result externref)))
  (import "env" "clear" (func $clear))
  (global $g (export "slot") (mut externref) (ref.null extern))
  (table $t (export "cells") 1 externref)
  ;; An import's result, returned through an export.
  (func (export "pass") (result externref)
    (call $make))
  ;; A global's reference, read into a local, then replaced by the guest.
  (func (export "takeGlobal") (result externref) (local $x externref)
    (local.set $x (global.get $g))
    (global.set $g (ref.null extern))
    (local.get $x))
  ;; A table's reference, read into a local, then replaced by the guest.
  (func (export "takeTable") (result externref) (local $x externref)
    (local.set $x (table.get $t (i32.const 0)))
    (table.set $t (i32.const 0) (ref.null extern))
    (local.get $x))
  ;; A global's reference, read into a local, then replaced by JavaScript
  ;; during an import call.
  (func (export "takeAcrossCall") (result externref) (local $x externref)
    (local.set $x (global.get $g))
    (call $clear)
    (local.get $x)))
