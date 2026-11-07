// AsyncDisposableStack disposes through Await: a disposer's answer that is a
// thenable adopts like a promise, while a [Symbol.dispose] fallback's own
// return value is never awaited (GetDisposeMethod wraps the fallback in a
// promise that answers undefined, and DisposeResources awaits that wrapper).
// Node.js prints the same.
const log = (...args) => console.log(...args);

// use, adopt and defer answers all go through Await, so each thenable's
// settlement finishes before the next resource disposes.
async function thenableAnswers() {
  const stack = new AsyncDisposableStack();
  stack.use({
    [Symbol.asyncDispose]() {
      log("use called");
      const answer = {
        then(resolve) {
          log("use then called");
          setTimeout(() => {
            log("use settled");
            resolve();
          }, 5);
        },
      };
      return answer;
    },
  });
  stack.adopt("adopted", (value) => {
    log("adopt called", value);
    const answer = {
      then(resolve) {
        log("adopt then called");
        setTimeout(() => {
          log("adopt settled");
          resolve();
        }, 5);
      },
    };
    return answer;
  });
  stack.defer(() => {
    log("defer called");
    const answer = {
      then(resolve) {
        log("defer then called");
        log("defer settled");
        resolve();
      },
    };
    return answer;
  });
  await stack.disposeAsync();
  log("thenable answers complete");
}

// A sync fallback's answer is dropped unread: even a promise it returns is
// not awaited, and a thenable's `then` is never called.
async function syncFallbackAnswers() {
  const seen = [];
  const stack = new AsyncDisposableStack();
  stack.use({
    [Symbol.dispose]() {
      seen.push("promise dispose");
      return new Promise((resolve) => {
        setTimeout(() => {
          seen.push("fallback promise settled");
          resolve(undefined);
        }, 5);
      });
    },
  });
  stack.use({
    [Symbol.dispose]() {
      seen.push("thenable dispose");
      return {
        then() {
          seen.push("fallback then read");
        },
      };
    },
  });
  await stack.disposeAsync();
  seen.push("disposeAsync done");
  await new Promise((resolve) => setTimeout(resolve, 10));
  log("sync fallback:", seen.join(", "));
}

// Await over a thenable follows the resolution procedure: a rejection
// re-throws, a throwing `then` read rejects, and a non-callable `then` is an
// ordinary fulfilled value.
async function answersThatFail() {
  const rejecting = new AsyncDisposableStack();
  rejecting.use({
    [Symbol.asyncDispose]() {
      const answer = {
        then(_resolve, reject) {
          reject(new TypeError("thenable rejected"));
        },
      };
      return answer;
    },
  });
  try {
    await rejecting.disposeAsync();
  } catch (error) {
    log("thenable rejection:", error.name, error.message);
  }

  const throwing = new AsyncDisposableStack();
  throwing.use({
    [Symbol.asyncDispose]() {
      return {
        get then() {
          throw new RangeError("then read threw");
        },
      };
    },
  });
  try {
    await throwing.disposeAsync();
  } catch (error) {
    log("then read:", error.name, error.message);
  }

  const plain = new AsyncDisposableStack();
  plain.use({
    [Symbol.asyncDispose]() {
      return { then: 1 };
    },
  });
  await plain.disposeAsync();
  log("non-callable then: fulfilled");

  const suppressed = new AsyncDisposableStack();
  suppressed.use({
    [Symbol.asyncDispose]() {
      const answer = {
        then(_resolve, reject) {
          reject(new Error("first"));
        },
      };
      return answer;
    },
  });
  suppressed.defer(() => {
    throw new Error("second");
  });
  try {
    await suppressed.disposeAsync();
  } catch (error) {
    log("suppressed:", error.name, error.error.message, error.suppressed.message);
  }
}

// A throwing sync fallback still costs the wrapper's Await before the stack
// settles, as an async disposal does.
async function syncThrowTicks() {
  const order = [];
  const stack = new AsyncDisposableStack();
  stack.use({
    [Symbol.dispose]() {
      order.push("sync throw");
      throw new Error("sync boom");
    },
  });
  stack.disposeAsync().then(
    () => order.push("fulfilled"),
    (error) => order.push("rejected " + error.message),
  );
  order.push("after call");
  await Promise.resolve();
  order.push("tick 1");
  await Promise.resolve();
  order.push("tick 2");
  await Promise.resolve();
  order.push("tick 3");
  log("sync throw order:", order.join(", "));
}

async function main() {
  await thenableAnswers();
  await syncFallbackAnswers();
  await answersThatFail();
  await syncThrowTicks();
}

main();
