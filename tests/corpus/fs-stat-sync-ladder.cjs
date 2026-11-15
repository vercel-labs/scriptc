// The sync stat forms' option reads: each getter runs exactly once, in the
// order Node reads them (bigint, then throwIfNoEntry for stat/lstat; bigint
// alone for fstat), encoding and signal are never read, and the missing
// entry answer follows only the boolean false.
'use strict';
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stat-sync-"));
const file = path.join(dir, "f.txt");
const missing = path.join(dir, "nope");
fs.writeFileSync(file, "abc");

const counted = () => {
  const reads = [];
  const options = {};
  const entries = [
    ["bigint", true],
    ["throwIfNoEntry", true],
    ["encoding", "utf16le"],
    ["signal", 5],
  ];
  for (const [name, value] of entries) {
    Object.defineProperty(options, name, {
      get() {
        reads.push(name);
        return value;
      },
      enumerable: true,
    });
  }
  return { options, reads };
};

{
  const { options, reads } = counted();
  const stats = fs.statSync(file, options);
  console.log("statSync reads", reads.join(","), typeof stats.size);
}
{
  const { options, reads } = counted();
  const stats = fs.lstatSync(file, options);
  console.log("lstatSync reads", reads.join(","), typeof stats.size);
}
{
  const fd = fs.openSync(file, "r");
  const { options, reads } = counted();
  const stats = fs.fstatSync(fd, options);
  console.log("fstatSync reads", reads.join(","), typeof stats.size);
  fs.closeSync(fd);
}
{
  const { options, reads } = counted();
  let answer;
  try {
    answer = String(fs.statSync(missing, options));
  } catch (e) {
    answer = e.code;
  }
  console.log("missing reads", reads.join(","), answer);
}

// Only the boolean false suppresses the missing-entry error, and only the
// boolean true selects BigIntStats, as for the callback forms.
const numberTable = (options) => typeof fs.statSync(file, options).size;
console.log("bigint 1", numberTable({ bigint: 1 }));
console.log("bigint string", numberTable({ bigint: "yes" }));
console.log("bigint true", numberTable({ bigint: true }));
const missingAnswer = (options) => {
  try {
    const stats = fs.statSync(missing, options);
    return String(stats);
  } catch (e) {
    return e.code;
  }
};
console.log("throwIfNoEntry 0", missingAnswer({ throwIfNoEntry: 0 }));
console.log("throwIfNoEntry string", missingAnswer({ throwIfNoEntry: "false" }));
console.log("throwIfNoEntry false", missingAnswer({ throwIfNoEntry: false }));
const linkMiss = fs.lstatSync(missing, { throwIfNoEntry: false });
console.log("lstat throwIfNoEntry false", linkMiss === undefined ? "undefined" : "stats");

// Options positions that are not objects: the sync forms read members
// straight off the value.
console.log("string options", typeof fs.statSync(file, "utf8").size);
console.log("number options", typeof fs.lstatSync(file, 7).size);
console.log("default options", typeof fs.statSync(file).size);

const show = (label, fn) => {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, "throw", e.name, e.code, JSON.stringify(e.message));
  }
};

// Null options fail on the first member read Node makes.
show("statSync null options", () => fs.statSync(file, null));
show("lstatSync null options", () => fs.lstatSync(file, null));
{
  const fd = fs.openSync(file, "r");
  show("fstatSync null options", () => fs.fstatSync(fd, null));
  fs.closeSync(fd);
}

// The path validates before the option reads for statSync/lstatSync; the
// descriptor reads its option first, then the binding validates it.
show("statSync bad path", () =>
  fs.statSync(null, {
    get bigint() {
      throw new Error("bigint read");
    },
  }),
);
show("lstatSync bad path", () =>
  fs.lstatSync(null, {
    get bigint() {
      throw new Error("bigint read");
    },
  }),
);
show("statSync throwing bigint", () =>
  fs.statSync(file, {
    get bigint() {
      throw new Error("bigint read");
    },
  }),
);
show("statSync throwing throwIfNoEntry", () =>
  fs.statSync(file, {
    get throwIfNoEntry() {
      throw new Error("throwIfNoEntry read");
    },
  }),
);
show("fstatSync throwing bigint", () =>
  fs.fstatSync("x", {
    get bigint() {
      throw new Error("bigint read");
    },
  }),
);

// The descriptor errors the binding reports after the option reads.
show("fstatSync fractional fd", () => {
  fs.fstatSync(1.5);
});
show("fstatSync negative fd", () => {
  fs.fstatSync(-1);
});

fs.rmSync(dir, { recursive: true, force: true });
