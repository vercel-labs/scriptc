import { expect, test } from "vitest";
import { BlockBuilder, volatileSlotAccess } from "./blocks.js";
import { f64Lit } from "./common.js";

test("entry allocations precede instructions and temporaries stay unique", () => {
  const blocks = new BlockBuilder();
  const first = blocks.tmp();
  const second = blocks.slot();
  expect(first).not.toBe(second);
  blocks.line(`${first} = fadd double 0.0, 1.0`);
  blocks.entryAllocas.push(`${second} = alloca double`);
  blocks.terminate("ret void");
  expect(blocks.render()).toBe(
    `entry:\n  ${second} = alloca double\n  ${first} = fadd double 0.0, 1.0\n  ret void`,
  );
});

test("terminators suppress dead instructions and keep their first target", () => {
  const blocks = new BlockBuilder();
  blocks.br("done");
  blocks.line("invalid dead instruction");
  blocks.terminate("ret i32 99");
  expect(blocks.isTerminated()).toBe(true);
  blocks.startBlock("done");
  expect(blocks.isTerminated()).toBe(false);
  blocks.terminate("ret void");
  expect(blocks.render()).toBe("entry:\n  br label %done\ndone:\n  ret void");
});

test("unterminated unreachable joins receive an explicit terminator", () => {
  const blocks = new BlockBuilder();
  blocks.terminate("ret void");
  blocks.startBlock("join");
  expect(blocks.render()).toContain("join:\n  unreachable");
});

test("debug attachments precede instruction comments and skip comment-only lines", () => {
  const blocks = new BlockBuilder();
  blocks.debugLocation = "!7";
  blocks.line('; comment "quotes" ; remain text');
  blocks.line('call void @f(ptr @"name;part") ; instruction comment');
  blocks.terminate("ret void ; tail");
  expect(blocks.render()).toBe(
    [
      "entry:",
      '  ; comment "quotes" ; remain text',
      '  call void @f(ptr @"name;part"), !dbg !7 ; instruction comment',
      "  ret void, !dbg !7 ; tail",
    ].join("\n"),
  );
});

test("changing a debug location affects only subsequent instructions", () => {
  const blocks = new BlockBuilder();
  blocks.line("call void @first()");
  blocks.debugLocation = "!1";
  blocks.line("call void @second()");
  blocks.debugLocation = "!2";
  blocks.line("call void @third()");
  blocks.debugLocation = null;
  blocks.terminate("ret void");
  expect(blocks.render()).toContain("call void @first()\n");
  expect(blocks.render()).toContain("call void @second(), !dbg !1");
  expect(blocks.render()).toContain("call void @third(), !dbg !2");
  expect(blocks.render()).toContain("ret void");
});

test("counted loops expose one increment path and preserve nested block endings", () => {
  const blocks = new BlockBuilder();
  const visited: string[] = [];
  blocks.countedLoop(f64Lit(4), (index, next) => {
    visited.push(index, next);
    const skip = blocks.newLabel("skip");
    const emit = blocks.newLabel("emit");
    blocks.condBr("%condition", skip, emit);
    blocks.startBlock(skip);
    blocks.br(next);
    blocks.startBlock(emit);
    blocks.line(`call void @consume(double ${index})`);
  });
  blocks.terminate("ret void");
  const text = blocks.render();
  expect(visited).toHaveLength(2);
  expect(text).toContain("fcmp olt double");
  expect(text).toContain(`br label %${visited[1]}`);
  expect(text).toContain("fadd double");
  expect(text).not.toContain("unreachable");
});

test("inclusive loops and nested loops keep labels separate", () => {
  const blocks = new BlockBuilder();
  blocks.countedLoop(f64Lit(2), (outer) => {
    blocks.countedLoop(
      outer,
      (inner) => {
        blocks.line(`call void @consume(double ${inner})`);
      },
      "ole",
    );
  });
  blocks.terminate("ret void");
  const text = blocks.render();
  const labels = text.split("\n").filter((line) => line.endsWith(":"));
  expect(new Set(labels).size).toBe(labels.length);
  expect(text).toContain("fcmp olt double");
  expect(text).toContain("fcmp ole double");
  expect(text.match(/alloca double/g)).toHaveLength(2);
});

test("volatile slots render their loads and stores volatile and nothing else", () => {
  const slots = new Set(["%sc_l_a_0"]);
  expect(volatileSlotAccess("  %t1 = load ptr, ptr %sc_l_a_0 ; a", slots)).toBe(
    "  %t1 = load volatile ptr, ptr %sc_l_a_0 ; a",
  );
  expect(volatileSlotAccess("  store ptr %t1, ptr %sc_l_a_0, !dbg !7", slots)).toBe(
    "  store volatile ptr %t1, ptr %sc_l_a_0, !dbg !7",
  );
  expect(volatileSlotAccess("  store ptr null, ptr %sc_l_a_0", slots)).toBe(
    "  store volatile ptr null, ptr %sc_l_a_0",
  );
  // Other addresses, a slot stored as a value, prefixes and other opcodes.
  for (const line of [
    "  %t2 = load ptr, ptr %sc_l_a_01",
    "  store ptr %sc_l_a_0, ptr %sc_l_b_0",
    "  %t3 = getelementptr inbounds ptr, ptr %sc_l_a_0, i64 1",
    "  call void @scr_box_release(ptr %sc_l_a_0)",
    "  %t4 = load volatile ptr, ptr %sc_l_a_0",
  ])
    expect(volatileSlotAccess(line, slots)).toBe(line);

  const blocks = new BlockBuilder();
  blocks.volatileSlots = slots;
  blocks.entryAllocas.push("%sc_l_a_0 = alloca ptr");
  blocks.line("store ptr null, ptr %sc_l_a_0");
  blocks.terminate("ret void");
  expect(blocks.render()).toBe(
    "entry:\n  %sc_l_a_0 = alloca ptr\n  store volatile ptr null, ptr %sc_l_a_0\n  ret void",
  );
});
