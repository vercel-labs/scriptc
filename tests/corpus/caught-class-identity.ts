class EventBase {
  label: string;
  constructor(label: string) { this.label = label; }
}
class RetryEvent extends EventBase {
  attempts = 0;
}
class StopEvent extends EventBase {}

function inspect(value: unknown): string {
  if (value instanceof RetryEvent) {
    value.attempts++;
    return value.label;
  }
  return value instanceof StopEvent ? 'stop' : 'other';
}
function raise(value: EventBase): void { throw value; }
const event = new RetryEvent('retry');
try { raise(event); } catch (error) {
  const saved: unknown = error;
  console.log(error instanceof RetryEvent, inspect(saved), inspect(error));
  console.log(saved === event, (saved as RetryEvent).attempts);
  try { throw error; } catch (again) { console.log(inspect(again)); }
}
console.log(event.attempts);
try { throw new StopEvent('done'); } catch (error) { console.log(inspect(error)); }
try { throw 42; } catch (error) { console.log(inspect(error), typeof error); }
try { throw 'reason'; } catch (error) { console.log(inspect(error), typeof error); }

type FailureCode = { code?: string };
function readCode(value: unknown): string { return (value as FailureCode).code ?? 'none'; }
try { throw { code: 'RETRY', detail: 7 }; } catch (error) {
  console.log((error as FailureCode).code, readCode(error));
}
try { throw new Error('plain'); } catch (error) {
  console.log((error as FailureCode).code ?? 'none');
}

function delayed(): () => boolean {
  try { throw event; } catch (error) { return () => error === event && inspect(error) === 'retry'; }
}
const checkLater = delayed();
console.log(checkLater(), event.attempts);
