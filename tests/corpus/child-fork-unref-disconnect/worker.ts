// A child that outlives the parent's handles: it ignores the channel's
// close and keeps a bounded timer, so the parent's exit — not the child's —
// is what ends the program.
process.on("disconnect", () => {});
setTimeout(() => process.exit(0), 2000);
