process.send?.({ from: "child", kind: "fork-target" });
process.disconnect();
