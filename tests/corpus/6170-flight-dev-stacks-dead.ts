// React Flight's production server as compiled from its sources: the V8
// structured-stack parser (ReactFlightStackConfigV8) is development-only and
// is referenced only after the production `throw` stubs, so a production
// render never parses a stack. Statements after an abrupt statement never
// run: they may use APIs with no static lowering (Error.prepareStackTrace,
// CallSite) and must not make the program keep stack frames.
// V8's structured stack API, declared here as React's Flow build declares
// it (the program's own types, not Node's).
interface CallSite {
  getTypeName(): string | null;
  getMethodName(): string | null;
  getFunctionName(): string | null;
  getScriptNameOrSourceURL(): string | null;
  getEvalOrigin(): string | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  isNative(): boolean;
  isAsync(): boolean;
  isConstructor(): boolean;
  isToplevel(): boolean;
  isEval(): boolean;
  toString(): string;
}
declare global {
  interface ErrorConstructor {
    prepareStackTrace?: (error: Error, structuredStackTrace: CallSite[]) => string;
  }
}
type ReactStackTrace = Array<[string, string, number, number, number, number, boolean]>;

let framesToSkip: number = 0;
let collectedStackTrace: null | ReactStackTrace = null;
const identifierRegExp = /^[a-zA-Z_$][0-9a-zA-Z_$]*$/;

function getMethodCallName(callSite: CallSite): string {
  const typeName = callSite.getTypeName();
  const methodName = callSite.getMethodName();
  const functionName = callSite.getFunctionName();
  let result = '';
  if (functionName) {
    if (typeName && identifierRegExp.test(functionName) && functionName !== typeName) {
      result += typeName + '.';
    }
    result += functionName;
    if (methodName && functionName !== methodName && !functionName.endsWith('.' + methodName) && !functionName.endsWith(' ' + methodName)) {
      result += ' [as ' + methodName + ']';
    }
  } else {
    if (typeName) {
      result += typeName + '.';
    }
    result += methodName ? methodName : '<anonymous>';
  }
  return result;
}

function collectStackTracePrivate(error: Error, structuredStackTrace: CallSite[]): string {
  const result: ReactStackTrace = [];
  for (let i = framesToSkip; i < structuredStackTrace.length; i++) {
    const callSite = structuredStackTrace[i];
    let name = callSite.getFunctionName() || '<anonymous>';
    if (name.includes('react_stack_bottom_frame')) {
      break;
    } else if (callSite.isNative()) {
      result.push([name, '', 0, 0, 0, 0, callSite.isAsync()]);
    } else {
      if (callSite.isConstructor()) {
        name = 'new ' + name;
      } else if (!callSite.isToplevel()) {
        name = getMethodCallName(callSite);
      }
      if (name === '<anonymous>') {
        name = '';
      }
      let filename = callSite.getScriptNameOrSourceURL() || '<anonymous>';
      if (filename === '<anonymous>') {
        filename = '';
        if (callSite.isEval()) {
          const origin = callSite.getEvalOrigin();
          if (origin) {
            filename = origin.toString() + ', <anonymous>';
          }
        }
      }
      const line = callSite.getLineNumber() || 0;
      const col = callSite.getColumnNumber() || 0;
      result.push([name, filename, line, col, 0, 0, callSite.isAsync()]);
    }
  }
  collectedStackTrace = result;
  return '';
}

function collectStackTrace(error: Error, structuredStackTrace: CallSite[]): string {
  collectStackTracePrivate(error, structuredStackTrace);
  const name = error.name || 'Error';
  const message = error.message || '';
  let stack = name + ': ' + message;
  for (let i = 0; i < structuredStackTrace.length; i++) {
    stack += '\n    at ' + structuredStackTrace[i].toString();
  }
  return stack;
}

function parseStackTrace(error: Error, skipFrames: number): ReactStackTrace {
  collectedStackTrace = null;
  framesToSkip = skipFrames;
  const previousPrepare = Error.prepareStackTrace;
  Error.prepareStackTrace = collectStackTrace;
  let stack;
  try {
    stack = String(error.stack);
  } finally {
    Error.prepareStackTrace = previousPrepare;
  }
  if (collectedStackTrace !== null) {
    const result = collectedStackTrace;
    collectedStackTrace = null;
    return result;
  }
  return stack.split('\n').length > 0 ? [] : [];
}

function renderDebugModel(value: any): any {
  if (value !== null && typeof value === 'object' && value._debugStack != null) {
    return parseStackTrace(value._debugStack, 1);
  }
  return value;
}

function emitOutlinedDebugModelChunk(model: any): string {
  throw new Error('emitOutlinedDebugModel should never be called in production mode. This is a bug in React.');
  function replacer(this: any, parentPropertyName: string, value: any): any {
    return renderDebugModel(this[parentPropertyName]);
  }
  const json: string = JSON.stringify(model, replacer);
  return json;
}

function outlineComponentInfo(componentInfo: any): string {
  throw new Error('outlineComponentInfo should never be called in production mode. This is a bug in React.');
  const counter = { objectLimit: 10 };
  if (componentInfo.debugStack != null) {
    counter.objectLimit += parseStackTrace(componentInfo.debugStack, 1).length;
  }
  return emitOutlinedDebugModelChunk(componentInfo) + counter.objectLimit;
}

// The production render: elements become `id:json` rows.
type Element = { type: string; props: { [key: string]: string }; children: Element[] };
function el(type: string, props: { [key: string]: string }, children: Element[]): Element {
  return { type, props, children };
}
function renderModel(node: Element): string {
  const children = node.children.map(renderModel);
  return '["$","' + node.type + '",null,' + JSON.stringify(node.props).slice(0, -1) + (children.length > 0 ? (Object.keys(node.props).length > 0 ? ',' : '') + '"children":[' + children.join(',') + ']' : '') + '}]';
}
const rows: string[] = [];
const items: Element[] = [];
for (let i = 0; i < 3; i++) items.push(el('li', { key: 'k' + i }, []));
rows.push('0:' + renderModel(el('main', {}, [el('ul', { className: 'list' }, items)])));
console.log(rows.join('\n'));

// The production stubs themselves run and throw; their DEV bodies never do.
for (const stub of [() => outlineComponentInfo({ debugStack: new Error('owner') }), () => emitOutlinedDebugModelChunk({})]) {
  try {
    stub();
  } catch (error) {
    console.log((error as Error).message);
  }
}

export {};
