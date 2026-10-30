/* Frames for test_unwind.c with CFI that compilers emit rarely. Like the
 * frames in test_unwind_frames.ll, each takes a chain and calls its first
 * function with the rest. */
  .text

/* Saves rbx and r12, and leaves through an early epilogue under
 * remember_state before its call, so the call's rules come from
 * restore_state. */
  .globl asm_remember
  .type asm_remember,@function
asm_remember:
  .cfi_startproc
  pushq %rbx
  .cfi_def_cfa_offset 16
  .cfi_offset %rbx, -16
  pushq %r12
  .cfi_def_cfa_offset 24
  .cfi_offset %r12, -24
  subq $8, %rsp
  .cfi_def_cfa_offset 32
  movq (%rdi), %rax
  testq %rax, %rax
  jne 1f
  .cfi_remember_state
  addq $8, %rsp
  .cfi_def_cfa_offset 24
  popq %r12
  .cfi_def_cfa_offset 16
  .cfi_restore %r12
  popq %rbx
  .cfi_def_cfa_offset 8
  .cfi_restore %rbx
  retq
  .cfi_restore_state
1:
  movabsq $0x5151515151515151, %rbx
  movabsq $0x5252525252525252, %r12
  addq $8, %rdi
  callq *%rax
  addq $8, %rsp
  .cfi_def_cfa_offset 24
  popq %r12
  .cfi_def_cfa_offset 16
  popq %rbx
  .cfi_def_cfa_offset 8
  retq
  .cfi_endproc
  .size asm_remember, .-asm_remember

/* An rbp frame that saves r13 and r14 below rbp and moves the stack
 * pointer by an amount that depends on the chain's address. */
  .globl asm_rbp
  .type asm_rbp,@function
asm_rbp:
  .cfi_startproc
  pushq %rbp
  .cfi_def_cfa_offset 16
  .cfi_offset %rbp, -16
  movq %rsp, %rbp
  .cfi_def_cfa_register %rbp
  pushq %r13
  pushq %r14
  .cfi_offset %r13, -24
  .cfi_offset %r14, -32
  movq %rdi, %rax
  andq $0x70, %rax
  subq %rax, %rsp
  movabsq $0x5353535353535353, %r13
  movabsq $0x5454545454545454, %r14
  movq (%rdi), %rax
  addq $8, %rdi
  callq *%rax
  leaq -16(%rbp), %rsp
  popq %r14
  popq %r13
  popq %rbp
  .cfi_def_cfa %rsp, 8
  retq
  .cfi_endproc
  .size asm_rbp, .-asm_rbp

/* Defines its CFA with a DWARF expression (rsp + 16), which the plans do
 * not express: raises through it go to libgcc's unwinder. */
  .globl asm_expr
  .type asm_expr,@function
asm_expr:
  .cfi_startproc
  pushq %rbx
  .cfi_escape 0x0f, 0x02, 0x77, 0x10
  .cfi_offset %rbx, -16
  movabsq $0x5555555555555555, %rbx
  movq (%rdi), %rax
  addq $8, %rdi
  callq *%rax
  popq %rbx
  .cfi_def_cfa %rsp, 8
  retq
  .cfi_endproc
  .size asm_expr, .-asm_expr

  .section .note.GNU-stack,"",@progbits
