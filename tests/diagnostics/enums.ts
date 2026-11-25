// The enum fences: everything that does NOT fold to a compile-time
// constant is a pointed, named rejection — never a silently-wrong value.
// (Constant-member enums themselves lower; see the 183x corpus programs.
// The enum object's own refusals are in enum-objects.ts.)

// A computed member's initializer is a runtime expression Node evaluates
// when the declaration executes — the declaration fences on the member.
enum Computed {
  Ok = 1,
  Len = "abc".length,
}

// Reads of the computed member fence at the use site too.
console.log(Computed.Len);

enum E {
  A,
  B,
}

// A constant reverse index no member carries: Node answers undefined,
// which the reverse mapping's `string` type cannot carry.
console.log(E[42]);
