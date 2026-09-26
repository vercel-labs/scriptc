console.log("from", Array.from([1, 2, 3]).join("|"));
console.log("map", Array.from([2, 3], (value, index) => value + index).join("|"));
console.log("of", Array.of(4).join("|"), Array.of("a", "b").join("|"));
console.log("set", Array.from(new Set(["b", "a", "b"])).join("|"));
console.log("string-map", Array.from("A💫B", (character, index) => `${index}:${character}`).join("|"));
