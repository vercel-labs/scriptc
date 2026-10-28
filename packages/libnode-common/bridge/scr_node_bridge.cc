// The libnode bridge: the C ABI of packages/runtime/src/scr_node_bridge.h
// over Node's C++ embedder API. It is built against one exact Node release
// (build-pack.mjs) and ships in that release's libnode pack next to
// libnode; the scriptc runtime dlopens it on the first call into Node and
// never includes a Node or V8 header itself.
//
// One environment per process, created from Node's built-in startup
// snapshot. Node keeps its hands off process-wide state that scriptc owns:
// no default signal handling, no debug-signal handler or inspector, no
// stdio reinitialization, one platform worker thread. Node's process exit
// (process.exit, an uncaught exception) goes to the runtime's exit
// sequence. Calls run in a CallbackScope with a nested TryCatch, so ticks
// and microtasks drain when the scope closes, as after any libuv callback.
#include "scr_node_bridge.h"

#include <dlfcn.h>
#include <node.h>
#include <node_api.h>
#include <node_version.h>
#include <uv.h>
#include <v8.h>

#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {

using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::Global;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::Locker;
using v8::NewStringType;
using v8::Object;
using v8::String;
using v8::TryCatch;
using v8::Value;

const ScrNodeBridgeHost *g_host = nullptr;
std::unique_ptr<node::MultiIsolatePlatform> g_platform;
node::EmbedderSnapshotData::Pointer g_snapshot;
std::unique_ptr<node::CommonEnvironmentSetup> g_setup;
Locker *g_locker = nullptr;
Global<Function> g_call;
Global<Function> g_finish;

char *Copy(const std::string &text, size_t *len) {
  char *out = static_cast<char *>(std::malloc(text.size() + 1));
  if (out == nullptr) std::abort();
  std::memcpy(out, text.data(), text.size());
  out[text.size()] = '\0';
  if (len != nullptr) *len = text.size();
  return out;
}

// The start of the runtime's stack when the caller runs on it (see the
// v8::base::Stack definitions at the end of this file), else 0.
uintptr_t HostStackStart() {
  return g_host != nullptr && g_host->stack_start != nullptr ? g_host->stack_start() : 0;
}

Local<String> Utf8(Isolate *isolate, const char *text, size_t len) {
  return String::NewFromUtf8(isolate, text, NewStringType::kNormal, static_cast<int>(len))
      .ToLocalChecked();
}

// A string longer than V8 can hold is empty instead of a fatal error.
v8::MaybeLocal<String> MaybeUtf8(Isolate *isolate, const char *text, size_t len) {
  if (len > static_cast<size_t>(String::kMaxLength)) return {};
  return String::NewFromUtf8(isolate, text, NewStringType::kNormal, static_cast<int>(len));
}

Local<String> Utf8(Isolate *isolate, const char *text) {
  return Utf8(isolate, text, std::strlen(text));
}

std::string ToStdString(Isolate *isolate, Local<Value> value) {
  String::Utf8Value text(isolate, value);
  return *text != nullptr ? std::string(*text, text.length()) : std::string();
}

// The outcome of an exception the dispatcher itself did not catch (a stack
// overflow, for example): an Error copy with its message.
// Reading the message runs user code (a getter, a toString), which may throw
// again; the copy then has an empty message.
std::string ThrownOutcome(Isolate *isolate, Local<Context> context, Local<Value> exception) {
  TryCatch inner(isolate);
  Local<Value> message = exception;
  if (exception->IsObject()) {
    Local<Value> own;
    if (exception.As<Object>()->Get(context, Utf8(isolate, "message")).ToLocal(&own))
      message = own;
  }
  Local<String> text;
  Local<String> quoted;
  if (!message->ToString(context).ToLocal(&text) ||
      !v8::JSON::Stringify(context, text).ToLocal(&quoted))
    return "T{\"error\":{\"kind\":0,\"message\":\"\"}}";
  return "T{\"error\":{\"kind\":0,\"message\":" + ToStdString(isolate, quoted) + "}}";
}

// The bootstrap's settle(id, outcome) for asynchronous calls.
void Settle(const FunctionCallbackInfo<Value> &info) {
  Isolate *isolate = info.GetIsolate();
  uint32_t id = info[0]->Uint32Value(isolate->GetCurrentContext()).FromMaybe(0);
  std::string outcome = ToStdString(isolate, info[1]);
  g_host->settle(id, outcome.data(), outcome.size());
}

char *Start(const ScrNodeBridgeHost *host, const char *bootstrap, const char *argv0,
            uintptr_t stack_limit) {
  if (g_setup) return nullptr;
  g_host = host;
  // Native addons resolve napi_* and node::* in the global scope: promote
  // libnode, a dependency of this library, to RTLD_GLOBAL.
  Dl_info info;
  if (dladdr(reinterpret_cast<void *>(&napi_create_function), &info) && info.dli_fname)
    dlopen(info.dli_fname, RTLD_NOW | RTLD_NOLOAD | RTLD_GLOBAL);
  std::vector<std::string> args = {argv0};
  // The program is not a node process: NODE_OPTIONS from its environment
  // does not apply, and Node leaves the process's resource limits and code
  // pages as they are.
  auto result = node::InitializeOncePerProcess(
      args, {node::ProcessInitializationFlags::kNoInitializeV8,
             node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
             node::ProcessInitializationFlags::kNoStdioInitialization,
             node::ProcessInitializationFlags::kNoDefaultSignalHandling,
             node::ProcessInitializationFlags::kNoPrintHelpOrVersionOutput,
             node::ProcessInitializationFlags::kDisableNodeOptionsEnv,
             node::ProcessInitializationFlags::kNoAdjustResourceLimits,
             node::ProcessInitializationFlags::kNoUseLargePages});
  if (result->early_return() || result->exit_code() != 0) {
    std::string message = "Node initialization failed";
    for (const std::string &error : result->errors()) message += ": " + error;
    return Copy(message, nullptr);
  }
  g_platform = node::MultiIsolatePlatform::Create(1);
  v8::V8::InitializePlatform(g_platform.get());
  v8::V8::Initialize();
  g_snapshot = node::EmbedderSnapshotData::BuiltinSnapshotData();
  // Modules resolve inside the program's own module tree, never from
  // NODE_PATH or the user's global module directories.
  auto flags = static_cast<node::EnvironmentFlags::Flags>(
      node::EnvironmentFlags::kDefaultFlags | node::EnvironmentFlags::kNoCreateInspector |
      node::EnvironmentFlags::kNoStartDebugSignalHandler |
      node::EnvironmentFlags::kNoGlobalSearchPaths);
  std::vector<std::string> errors;
  g_setup = g_snapshot ? node::CommonEnvironmentSetup::CreateFromSnapshot(
                             g_platform.get(), &errors, g_snapshot.get(), result->args(),
                             result->exec_args(), flags)
                       : node::CommonEnvironmentSetup::Create(g_platform.get(), &errors,
                                                              result->args(),
                                                              result->exec_args(), flags);
  if (!g_setup) {
    std::string message = "cannot create the Node environment";
    for (const std::string &error : errors) message += ": " + error;
    return Copy(message, nullptr);
  }
  Isolate *isolate = g_setup->isolate();
  g_locker = new Locker(isolate);
  isolate->Enter();
  // The runtime calls into Node on a dedicated stack of its own
  // (scr_node_island.c), not the thread's: V8's limit follows it.
  if (stack_limit != 0) isolate->SetStackLimit(stack_limit);
  node::SetProcessExitHandler(g_setup->env(),
                              [](node::Environment *, int code) { g_host->exit(code); });
  HandleScope handles(isolate);
  Local<Context> context = g_setup->context();
  Context::Scope context_scope(context);
  Local<Object> global = context->Global();
  Local<Object> native = Object::New(isolate);
  native
      ->Set(context, Utf8(isolate, "settle"), Function::New(context, Settle).ToLocalChecked())
      .Check();
  global->Set(context, Utf8(isolate, "__scriptcNodeIslandHost"), native).Check();
  TryCatch try_catch(isolate);
  if (node::LoadEnvironment(g_setup->env(), bootstrap).IsEmpty()) {
    std::string message = "the Node island bootstrap failed";
    if (try_catch.HasCaught()) {
      Local<Value> stack;
      Local<Value> exception = try_catch.Exception();
      if (exception->IsObject() &&
          exception.As<Object>()->Get(context, Utf8(isolate, "stack")).ToLocal(&stack) &&
          stack->IsString())
        exception = stack;
      message += ": " + ToStdString(isolate, exception);
    } else if (try_catch.HasTerminated()) {
      message += ": execution terminated";
    }
    return Copy(message, nullptr);
  }
  Local<Value> dispatcher;
  Local<Value> call;
  Local<Value> finish;
  if (!global->Get(context, Utf8(isolate, "__scriptcNodeIsland")).ToLocal(&dispatcher) ||
      !dispatcher->IsObject() ||
      !dispatcher.As<Object>()->Get(context, Utf8(isolate, "call")).ToLocal(&call) ||
      !call->IsFunction() ||
      !dispatcher.As<Object>()->Get(context, Utf8(isolate, "finish")).ToLocal(&finish) ||
      !finish->IsFunction())
    return Copy("the Node island bootstrap left no dispatcher", nullptr);
  g_call.Reset(isolate, call.As<Function>());
  g_finish.Reset(isolate, finish.As<Function>());
  global->Delete(context, Utf8(isolate, "__scriptcNodeIsland")).FromMaybe(false);
  global->Delete(context, Utf8(isolate, "__scriptcNodeIslandHost")).FromMaybe(false);
  return nullptr;
}

char *Call(uint32_t id, int sync, const char *file, const char *specifier, const char *name,
           const char *args, size_t args_len, size_t *len) {
  Isolate *isolate = g_setup->isolate();
  HandleScope handles(isolate);
  Local<Context> context = g_setup->context();
  Context::Scope context_scope(context);
  std::string outcome;
  {
    node::CallbackScope scope(isolate, context->Global(), node::async_context{0, 0});
    TryCatch try_catch(isolate);
    Local<String> args_text;
    if (!MaybeUtf8(isolate, args, args_len).ToLocal(&args_text)) {
      // The argument JSON is longer than V8's string limit: the RangeError
      // V8 throws for such a string.
      outcome = "T{\"error\":{\"kind\":2,\"message\":\"Invalid string length\"}}";
      if (!sync) {
        g_host->settle(id, outcome.data(), outcome.size());
        return nullptr;
      }
      return Copy(outcome, len);
    }
    Local<Value> argv[] = {Integer::NewFromUnsigned(isolate, id),
                           v8::Boolean::New(isolate, sync != 0),
                           Utf8(isolate, file),
                           Utf8(isolate, specifier),
                           Utf8(isolate, name),
                           args_text};
    Local<Value> result;
    if (g_call.Get(isolate)
            ->Call(context, v8::Undefined(isolate), sizeof argv / sizeof argv[0], argv)
            .ToLocal(&result)) {
      if (result->IsString()) outcome = ToStdString(isolate, result);
    } else if (try_catch.HasCaught() && !try_catch.HasTerminated()) {
      outcome = ThrownOutcome(isolate, context, try_catch.Exception());
      if (!sync) {
        g_host->settle(id, outcome.data(), outcome.size());
        outcome.clear();
      }
    }
  }
  if (!sync) return nullptr;
  if (outcome.empty()) outcome = "T{\"undefined\":true}";
  return Copy(outcome, len);
}

void Release(void *memory) { std::free(memory); }

int BackendFd() { return uv_backend_fd(g_setup->event_loop()); }

int BackendTimeout() { return uv_backend_timeout(g_setup->event_loop()); }

int Alive() { return uv_loop_alive(g_setup->event_loop()); }

void Pump() {
  Isolate *isolate = g_setup->isolate();
  HandleScope handles(isolate);
  Context::Scope context_scope(g_setup->context());
  uv_run(g_setup->event_loop(), UV_RUN_NOWAIT);
  g_platform->DrainTasks(isolate);
}

// The program ends with `code`: Node's process ends with it too. Node's
// 'beforeExit' runs (and the work it schedules), then 'exit'; the result
// is the exit code Node's process ends with (process.exitCode).
int Finish(int code) {
  if (!g_setup) return code;
  Isolate *isolate = g_setup->isolate();
  {
    HandleScope handles(isolate);
    Local<Context> context = g_setup->context();
    Context::Scope context_scope(context);
    TryCatch try_catch(isolate);
    Local<Value> argv[] = {Integer::New(isolate, code)};
    (void)g_finish.Get(isolate)->Call(context, v8::Undefined(isolate), 1, argv);
  }
  return node::SpinEventLoop(g_setup->env()).FromMaybe(code);
}

void Stop() {
  if (!g_setup) return;
  Isolate *isolate = g_setup->isolate();
  node::Stop(g_setup->env());
  g_call.Reset();
  g_finish.Reset();
  isolate->Exit();
  delete g_locker;
  g_locker = nullptr;
  g_setup.reset();
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
}

const ScrNodeBridge kBridge = {
    SCR_NODE_BRIDGE_ABI, NODE_VERSION_STRING, NODE_MODULE_VERSION, Start, Call, Release,
    BackendFd,           BackendTimeout,      Alive,               Pump,  Stop,
    Finish,
};

}  // namespace

#if defined(__linux__)
// V8 asks v8::base::Stack for the start of the current thread's stack when
// it records the bound of its conservative stack scan (isolate creation,
// Locker). libnode calls these exported functions through its PLT, and this
// library precedes libnode in the lookup scope, so the definitions below
// answer for it: the runtime's stack while the caller runs on it, else
// libnode's own answer (RTLD_NEXT). Without them a garbage collection that
// scans the stack while JavaScript runs on the runtime's stack walks from
// that stack up to the main thread's and faults in the unmapped gap.
// macOS binds libnode's calls inside libnode instead: there the runtime
// points the main thread's pthread stack record at its stack while Node
// starts (ni_pthread_stack_enter in scr_node_island.c).
#define SCR_V8_STACK_START(fn, symbol)                                          \
  extern "C" __attribute__((visibility("default"))) void *fn() __asm__(symbol); \
  extern "C" void *fn() {                                                       \
    static void *(*next)() = nullptr;                                           \
    uintptr_t start = HostStackStart();                                         \
    if (start != 0) return reinterpret_cast<void *>(start);                     \
    if (next == nullptr) next = reinterpret_cast<void *(*)()>(dlsym(RTLD_NEXT, symbol)); \
    return next != nullptr ? next() : nullptr;                                  \
  }
SCR_V8_STACK_START(ScrV8GetStackStart, "_ZN2v84base5Stack13GetStackStartEv")
SCR_V8_STACK_START(ScrV8GetStackStartUnchecked, "_ZN2v84base5Stack22GetStackStartUncheckedEv")
SCR_V8_STACK_START(ScrV8ObtainCurrentThreadStackStart,
                   "_ZN2v84base5Stack29ObtainCurrentThreadStackStartEv")
#undef SCR_V8_STACK_START
#endif

extern "C" __attribute__((visibility("default"))) const ScrNodeBridge *scr_node_bridge_v1() {
  return &kBridge;
}
