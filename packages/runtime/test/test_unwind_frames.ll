; Frames for test_unwind.c, shaped like emitted code on the unwinding
; exception ABI. Every frame takes a chain: a null-terminated array of frame
; functions, of which it calls the first with the rest. Each clobbers the
; callee-saved registers, so its prologue saves them and its CFI says where.
target triple = "x86_64-unknown-linux-gnu"

declare void @scr_unwind_raise() cold
declare void @scr_unwind_resume(ptr) cold
declare i32 @__gcc_personality_v0(...)
declare void @test_cleanup(ptr)
declare void @test_touch(ptr)

; Clobbers every callee-saved register the frame pointer leaves free.
define private void @clobber() alwaysinline {
  call void asm sideeffect "movq $$0x6161616161616161, %rbx\0Amovq $$0x6262626262626262, %r12\0Amovq $$0x6363636363636363, %r13\0Amovq $$0x6464646464646464, %r14\0Amovq $$0x6565656565656565, %r15", "~{rbx},~{r12},~{r13},~{r14},~{r15}"()
  ret void
}

; A local that escapes, so sanitized builds give the frame redzones.
define private void @local() alwaysinline sanitize_address {
  %buf = alloca [48 x i8], align 16
  call void @test_touch(ptr %buf)
  ret void
}

define void @ir_raise(ptr %chain) sanitize_address {
  call void @local()
  call void @clobber()
  call void @scr_unwind_raise()
  unreachable
}

define void @ir_plain(ptr %chain) sanitize_address {
  call void @local()
  %fn = load ptr, ptr %chain
  %rest = getelementptr ptr, ptr %chain, i64 1
  call void @clobber()
  call void %fn(ptr %rest)
  ret void
}

define void @ir_plain_fp(ptr %chain) sanitize_address "frame-pointer"="all" {
  call void @local()
  %fn = load ptr, ptr %chain
  %rest = getelementptr ptr, ptr %chain, i64 1
  call void @clobber()
  call void %fn(ptr %rest)
  ret void
}

; A frame whose stack pointer moves by a runtime amount: its CFA is rbp's.
define void @ir_alloca(ptr %chain) sanitize_address {
  %bits = ptrtoint ptr %chain to i64
  %n = and i64 %bits, 112
  %size = add i64 %n, 16
  %dyn = alloca i8, i64 %size, align 16
  call void @test_touch(ptr %dyn)
  %fn = load ptr, ptr %chain
  %rest = getelementptr ptr, ptr %chain, i64 1
  call void @clobber()
  call void %fn(ptr %rest)
  ret void
}

; A frame with a landing pad: it records its chain position and continues
; the unwind. The chain position is live across the call.
define void @ir_pad(ptr %chain) sanitize_address personality ptr @__gcc_personality_v0 {
entry:
  call void @local()
  %fn = load ptr, ptr %chain
  %rest = getelementptr ptr, ptr %chain, i64 1
  call void @clobber()
  invoke void %fn(ptr %rest) to label %ok unwind label %lp
ok:
  ret void
lp:
  %e = landingpad { ptr, i32 } cleanup
  call void @test_cleanup(ptr %chain)
  %token = extractvalue { ptr, i32 } %e, 0
  call void @scr_unwind_resume(ptr %token)
  unreachable
}

define void @ir_pad_fp(ptr %chain) sanitize_address "frame-pointer"="all" personality ptr @__gcc_personality_v0 {
entry:
  call void @local()
  %fn = load ptr, ptr %chain
  %rest = getelementptr ptr, ptr %chain, i64 1
  call void @clobber()
  invoke void %fn(ptr %rest) to label %ok unwind label %lp
ok:
  ret void
lp:
  %e = landingpad { ptr, i32 } cleanup
  call void @test_cleanup(ptr %chain)
  %token = extractvalue { ptr, i32 } %e, 0
  call void @scr_unwind_resume(ptr %token)
  unreachable
}

; Takes the exception, as a pending-flag frame does: returns a checksum of
; six values live across the call, which hold the callee-saved registers,
; and whether the call raised in bit 63.
define i64 @ir_catch(ptr %chain, i64 %a, i64 %b, i64 %c, i64 %d, i64 %e, i64 %f) sanitize_address personality ptr @__gcc_personality_v0 {
entry:
  call void @local()
  %x1 = mul i64 %a, 3
  %x2 = mul i64 %b, 5
  %x3 = mul i64 %c, 7
  %x4 = mul i64 %d, 11
  %x5 = mul i64 %e, 13
  %x6 = mul i64 %f, 17
  %fn = load ptr, ptr %chain
  %rest = getelementptr ptr, ptr %chain, i64 1
  invoke void %fn(ptr %rest) to label %ok unwind label %lp
ok:
  br label %done
lp:
  %l = landingpad { ptr, i32 } cleanup
  br label %done
done:
  %raised = phi i64 [ 0, %ok ], [ -9223372036854775808, %lp ]
  %s1 = xor i64 %x1, %x2
  %s2 = add i64 %s1, %x3
  %s3 = xor i64 %s2, %x4
  %s4 = add i64 %s3, %x5
  %s5 = xor i64 %s4, %x6
  %s6 = and i64 %s5, 9223372036854775807
  %r = or i64 %s6, %raised
  ret i64 %r
}
