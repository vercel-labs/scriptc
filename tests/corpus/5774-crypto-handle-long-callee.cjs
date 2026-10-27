// A missing method called on a Hash, Hmac or KeyObject held in an untyped
// value throws Node's TypeError with the whole callee text, also when the
// text is longer than a fixed-size message buffer.
const { createHash, createHmac, createSecretKey } = require("node:crypto");

const holder = {
  aHashValueStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixtyBytes:
    createHash("sha256"),
  anHmacValueStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixtyBytes:
    createHmac("sha256", "key"),
  aSecretKeyObjectStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixty:
    createSecretKey(Buffer.alloc(16, 1)),
};

function report(label, run) {
  try {
    run();
    console.log(label, "did not throw");
  } catch (e) {
    console.log(label, e instanceof TypeError, e.name, e.message.length);
    console.log(e.message);
  }
}

report("hash", () =>
  holder.aHashValueStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixtyBytes.missingMethodOnTheHashValue(),
);
report("hmac", () =>
  holder.anHmacValueStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixtyBytes.missingMethodOnTheHmacValue(),
);
report("key", () =>
  holder.aSecretKeyObjectStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixty.missingMethodOnTheKeyObject(),
);

// A short callee text through an untyped parameter, for comparison.
function callMissing(value) {
  return value.nope();
}
report("short", () =>
  callMissing(holder.aHashValueStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixtyBytes),
);
console.log(
  holder.aHashValueStoredUnderAPropertyNameLongEnoughThatTheCalleeTextOfTheMissingMethodRunsPastOneHundredAndSixtyBytes
    .update("abc")
    .digest("hex"),
);
