const controller = new AbortController();
const signal = controller.signal;
console.log(
  "controller initial:",
  signal.aborted,
  controller.signal === signal,
);

const reason = { value: 1 };
let eventCalls = 0;
signal.addEventListener("abort", (event) => {
  eventCalls++;
  console.log(
    "controller event:",
    event.type,
    event.target === signal,
    (signal.reason as { value: number }) === reason,
  );
});
controller.abort(reason);
controller.abort(new Error("ignored"));
const observedReason = signal.reason as { value: number };
observedReason.value = 2;
console.log(
  "controller final:",
  signal.aborted,
  eventCalls,
  observedReason === reason,
  reason.value,
);

const computedController = new AbortController();
const abortMember: "abort" = "abort";
computedController[abortMember]("computed reason");
console.log("computed abort:", computedController.signal.reason);

let surplusEffects = "";
function constructorSurplus(): number {
  surplusEffects += "ctor ";
  return 1;
}
function abortSurplus(): number {
  surplusEffects += "abort";
  return 2;
}
// @ts-expect-error JavaScript accepts and evaluates surplus constructor arguments.
const surplusController = new AbortController(constructorSurplus());
// @ts-expect-error JavaScript also evaluates surplus abort() arguments.
surplusController.abort(undefined, abortSurplus());
console.log("controller surplus:", surplusEffects);

let ignoredMapEffect = "";
function ignoredMapSurplus(): Map<string, string> {
  ignoredMapEffect = "map";
  return new Map<string, string>();
}
const mapSurplusController = new AbortController();
// @ts-expect-error JavaScript evaluates and ignores every surplus argument.
mapSurplusController.abort(undefined, ignoredMapSurplus());
console.log(
  "controller map surplus:",
  ignoredMapEffect,
  mapSurplusController.signal.aborted,
);

const selfReasonController = new AbortController();
selfReasonController.abort(selfReasonController);
console.log(
  "controller self reason:",
  selfReasonController.signal.reason === selfReasonController,
);

const signalReasonController = new AbortController();
const ownSignalReason = signalReasonController.signal;
signalReasonController.abort(ownSignalReason);
console.log(
  "controller signal reason:",
  ownSignalReason.reason === ownSignalReason,
);

const leftReasonController = new AbortController();
const rightReasonController = new AbortController();
leftReasonController.abort(rightReasonController);
rightReasonController.abort(leftReasonController);
console.log(
  "controller mutual reasons:",
  leftReasonController.signal.reason === rightReasonController,
  rightReasonController.signal.reason === leftReasonController,
);

const watchedReasonController = new AbortController();
const watchedReasonSignal = AbortSignal.any([watchedReasonController.signal]);
watchedReasonController.abort(watchedReasonController);
let watchedThrowMatches = false;
try {
  watchedReasonSignal.throwIfAborted();
} catch (error) {
  watchedThrowMatches = error === watchedReasonController;
}
console.log(
  "controller propagated reason:",
  watchedReasonSignal.reason === watchedReasonController,
  watchedThrowMatches,
);

try {
  await fetch(`${process.argv[2]}/slow`, {
    signal: selfReasonController.signal,
  });
  console.log("controller pre-aborted fetch unexpectedly resolved");
} catch (error) {
  console.log(
    "controller pre-aborted fetch reason:",
    error === selfReasonController,
  );
}

const fetchController = new AbortController();
setTimeout(() => fetchController.abort(new Error("manual timeout")), 20);
try {
  await fetch(`${process.argv[2]}/slow`, {
    signal: fetchController.signal,
  });
  console.log("controller fetch unexpectedly resolved");
} catch (error) {
  const caught = error as Error;
  console.log("controller fetch:", caught.name, caught.message);
}
