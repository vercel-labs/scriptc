/**
 * WASM Dynamic Linking - Extension Loader
 *
 * Loads WASM shared libraries (.so) compiled with wasi-sdk as extensions
 * for the QuickJS WASM runtime. Extensions can call QuickJS C API functions
 * directly through dynamic linking (shared memory + symbol resolution).
 *
 * Key concepts:
 * - Extensions are WASM shared libraries with a `dylink.0` custom section
 * - They share linear memory and the indirect function table with the main module
 * - Symbol imports (env.*) are resolved against the main module's exports
 * - Each extension gets a unique __memory_base and __table_base
 * - Extensions export an init function (e.g., `qjs_ext_url_init`)
 */
const decoder = new TextDecoder();
/**
 * Parse a null-terminated "key=value\nkey=value" string from WASM memory
 * into a Record<string, string>. Used to read version info from extensions.
 */
function parseVersionString(memory, ptr) {
    const mem = new Uint8Array(memory.buffer);
    let end = ptr;
    while (mem[end] !== 0)
        end++;
    if (end === ptr)
        return {};
    const str = decoder.decode(mem.slice(ptr, end));
    const result = {};
    for (const line of str.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            result[line.slice(0, eq)] = line.slice(eq + 1);
        }
    }
    return result;
}
/**
 * Check if an extension exports a versions function and parse the result.
 */
function extractExtensionVersions(ext, memory) {
    const versionsFnName = `qjs_ext_${ext.name.replace(/-/g, '_')}_versions`;
    const versionsFn = ext.instance.exports[versionsFnName];
    if (typeof versionsFn !== 'function')
        return undefined;
    const ptr = versionsFn();
    if (ptr === 0)
        return undefined;
    return parseVersionString(memory, ptr);
}
// ---- dylink.0 parser ----
/** Read a ULEB128-encoded integer from a byte array */
function readULEB128(bytes, offset) {
    let result = 0;
    let shift = 0;
    while (offset.value < bytes.length) {
        const byte = bytes[offset.value++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            break;
        shift += 7;
    }
    return result;
}
/** Parse the dylink.0 custom section from a WASM module */
export function parseDylink(module) {
    const sections = WebAssembly.Module.customSections(module, 'dylink.0');
    if (sections.length === 0)
        return null;
    const bytes = new Uint8Array(sections[0]);
    const offset = { value: 0 };
    const info = {
        memorySize: 0,
        memoryAlignment: 0,
        tableSize: 0,
        tableAlignment: 0,
        needed: [],
    };
    while (offset.value < bytes.length) {
        const subsectionType = readULEB128(bytes, offset);
        const subsectionSize = readULEB128(bytes, offset);
        const subsectionEnd = offset.value + subsectionSize;
        if (subsectionType === 1) {
            // WASM_DYLINK_MEM_INFO
            info.memorySize = readULEB128(bytes, offset);
            info.memoryAlignment = readULEB128(bytes, offset);
            info.tableSize = readULEB128(bytes, offset);
            info.tableAlignment = readULEB128(bytes, offset);
        }
        else if (subsectionType === 2) {
            // WASM_DYLINK_NEEDED
            const count = readULEB128(bytes, offset);
            for (let i = 0; i < count; i++) {
                const len = readULEB128(bytes, offset);
                const name = new TextDecoder().decode(bytes.slice(offset.value, offset.value + len));
                offset.value += len;
                info.needed.push(name);
            }
        }
        offset.value = subsectionEnd;
    }
    return info;
}
// ---- Alignment helper ----
/** Align a value up to 2^align */
function alignUp(value, align) {
    if (align <= 0)
        return value;
    const mask = (1 << align) - 1;
    return (value + mask) & ~mask;
}
// ---- Extension Loader ----
/**
 * Load a WASM shared library extension and link it against the main module.
 *
 * @param descriptor - Extension description (name, wasm bytes, init function)
 * @param mainExports - The main QuickJS WASM module's exports
 * @param wasiBuiltins - Built-in WASI implementations (lowest priority)
 * @param wasiUserOverrides - User-provided WASI overrides (highest priority)
 * @param memoryProxy - A memory proxy for extension WASI factories
 * @param allocBase - Optional fixed memory/table bases (for snapshot restore)
 */
export async function loadExtension(descriptor, mainExports, wasiBuiltins, wasiUserOverrides, memoryProxy, allocBase) {
    // Compile the extension module
    let module;
    if (descriptor.wasm instanceof WebAssembly.Module) {
        module = descriptor.wasm;
    }
    else {
        module = await WebAssembly.compile(descriptor.wasm);
    }
    // Parse dylink.0 section
    const dylink = parseDylink(module);
    if (!dylink) {
        throw new Error(`Extension "${descriptor.name}" is not a WASM shared library (missing dylink.0 section)`);
    }
    const memory = mainExports.memory;
    const table = mainExports.__indirect_function_table;
    const stackPointer = mainExports.__stack_pointer;
    const mallocFn = mainExports.malloc;
    if (!memory)
        throw new Error('Main module does not export memory');
    if (!table)
        throw new Error('Main module does not export __indirect_function_table');
    if (!mallocFn)
        throw new Error('Main module does not export malloc');
    // Allocate memory region for the extension's static data
    let memoryBase;
    let tableBase;
    if (allocBase) {
        // Restore mode: use the exact same bases as before
        memoryBase = allocBase.memoryBase;
        tableBase = allocBase.tableBase;
    }
    else {
        // Fresh allocation
        if (dylink.memorySize > 0) {
            // Use malloc from the main module to allocate in the shared heap
            memoryBase = mallocFn(dylink.memorySize);
            if (memoryBase === 0) {
                throw new Error(`Failed to allocate ${dylink.memorySize} bytes for extension "${descriptor.name}"`);
            }
            // Zero-initialize the region
            new Uint8Array(memory.buffer, memoryBase, dylink.memorySize).fill(0);
        }
        else {
            memoryBase = 0;
        }
    }
    // Grow the function table if needed
    if (allocBase) {
        tableBase = allocBase.tableBase;
        // Ensure table is large enough
        if (tableBase + dylink.tableSize > table.length) {
            table.grow(tableBase + dylink.tableSize - table.length);
        }
    }
    else {
        tableBase = table.length;
        if (dylink.tableSize > 0) {
            table.grow(dylink.tableSize);
        }
    }
    // Build the import object
    const extImports = WebAssembly.Module.imports(module);
    const importObj = {
        env: {},
        'GOT.mem': {},
        'GOT.func': {},
    };
    // Provide wasi_snapshot_preview1 imports to extensions that need them.
    // Layered merge: builtins → extension-provided → user overrides.
    const needsWasi = extImports.some((imp) => imp.module === 'wasi_snapshot_preview1');
    if (needsWasi) {
        const extWasi = (descriptor.wasi && memoryProxy) ? descriptor.wasi(memoryProxy) : undefined;
        importObj['wasi_snapshot_preview1'] = {
            ...wasiBuiltins, // 1. Built-in defaults (lowest priority)
            ...extWasi, // 2. Extension-provided
            ...wasiUserOverrides // 3. User overrides (highest priority)
        };
    }
    // Collect names of functions the extension exports (for self-resolution)
    const extExportNames = new Set(WebAssembly.Module.exports(module)
        .filter((e) => e.kind === 'function')
        .map((e) => e.name));
    const unresolvedFuncs = new Set();
    for (const imp of extImports) {
        if (imp.module === 'env') {
            if (imp.name === 'memory' && imp.kind === 'memory') {
                importObj.env.memory = memory;
            }
            else if (imp.name === '__indirect_function_table' &&
                imp.kind === 'table') {
                importObj.env.__indirect_function_table = table;
            }
            else if (imp.name === '__memory_base' && imp.kind === 'global') {
                importObj.env.__memory_base = new WebAssembly.Global({ value: 'i32', mutable: false }, memoryBase);
            }
            else if (imp.name === '__table_base' && imp.kind === 'global') {
                importObj.env.__table_base = new WebAssembly.Global({ value: 'i32', mutable: false }, tableBase);
            }
            else if (imp.name === '__stack_pointer' && imp.kind === 'global') {
                importObj.env.__stack_pointer = stackPointer;
            }
            else if (imp.kind === 'function') {
                // Resolve function imports from the main module's exports
                const resolved = mainExports[imp.name];
                if (resolved && typeof resolved === 'function') {
                    importObj.env[imp.name] = resolved;
                }
                else {
                    // Provide a trap stub for unresolved symbols (e.g., C++ runtime
                    // functions like wstring methods that are imported but never called).
                    // If actually called at runtime, this will throw.
                    unresolvedFuncs.add(imp.name);
                    importObj.env[imp.name] = () => {
                        throw new Error(`Extension "${descriptor.name}" called unresolved symbol: env.${imp.name}`);
                    };
                }
            }
            else if (imp.kind === 'global') {
                // Other globals - try to resolve from main exports
                const resolved = mainExports[imp.name];
                if (resolved instanceof WebAssembly.Global) {
                    importObj.env[imp.name] = resolved;
                }
                else {
                    // Create a zero-initialized mutable global as fallback
                    importObj.env[imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
                }
            }
        }
        else if (imp.module === 'GOT.mem' && imp.kind === 'global') {
            // GOT.mem entries are mutable globals containing memory addresses of symbols
            // Try to resolve the symbol's address - for now, create mutable globals
            // that can be patched by __wasm_apply_data_relocs
            importObj['GOT.mem'][imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
        }
        else if (imp.module === 'GOT.func' && imp.kind === 'global') {
            // GOT.func entries are mutable globals containing table indices of functions.
            // We resolve these by finding the function in the main module's exports,
            // adding it to the indirect function table, and providing the table index.
            const resolved = mainExports[imp.name];
            if (resolved && typeof resolved === 'function') {
                const idx = table.length;
                table.grow(1);
                table.set(idx, resolved);
                importObj['GOT.func'][imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, idx);
            }
            else {
                importObj['GOT.func'][imp.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
            }
        }
    }
    // Self-resolve: in WASM shared libraries, the linker with --allow-undefined
    // may leave symbols as both imports and exports (e.g., C++ weak symbols from
    // libc++ string.cpp.o that satisfy references from ada.o). We use indirection
    // through mutable wrapper functions: first create wrappers that initially trap,
    // then instantiate, then patch the wrappers to forward to the instance's own exports.
    // This way all internal calls go through the wrappers which point to the final exports.
    const selfResolvable = [...unresolvedFuncs].filter((name) => extExportNames.has(name));
    // For self-resolvable symbols, create mutable wrappers
    const wrappers = {};
    for (const name of selfResolvable) {
        const wrapper = { target: null };
        wrappers[name] = wrapper;
        // Replace the trap stub with a wrapper that forwards to the target
        importObj.env[name] = (...args) => {
            if (!wrapper.target) {
                throw new Error(`Extension "${descriptor.name}" called unresolved symbol during init: env.${name}`);
            }
            return wrapper.target(...args);
        };
    }
    const instance = await WebAssembly.instantiate(module, importObj);
    const extExports = instance.exports;
    // Patch wrappers to point to the instance's own exports
    for (const name of selfResolvable) {
        const selfExport = extExports[name];
        if (typeof selfExport === 'function') {
            wrappers[name].target = selfExport;
        }
    }
    // Apply data relocations if the extension has them
    if (typeof extExports.__wasm_apply_data_relocs === 'function') {
        extExports.__wasm_apply_data_relocs();
    }
    // Call constructors if present
    if (typeof extExports.__wasm_call_ctors === 'function') {
        extExports.__wasm_call_ctors();
    }
    const initFn = descriptor.initFn ?? `qjs_ext_${descriptor.name.replace(/-/g, '_')}_init`;
    const ext = {
        name: descriptor.name,
        module,
        instance,
        dylink,
        memoryBase,
        tableBase,
        initFn,
    };
    // Check for version reporting
    ext.versions = extractExtensionVersions(ext, memory);
    return ext;
}
/**
 * Call the extension's init function, passing the JSContext and JSRuntime
 * pointers from the main module.
 */
export function initExtension(ext, mainExports) {
    const initFunc = ext.instance.exports[ext.initFn];
    if (typeof initFunc !== 'function') {
        throw new Error(`Extension "${ext.name}" does not export init function "${ext.initFn}"`);
    }
    // Get the JSContext and JSRuntime pointers from the main module
    const ctxPtr = mainExports.qjs_get_context_ptr();
    const rtPtr = mainExports.qjs_get_runtime_ptr();
    // Call the extension's init function: qjs_ext_xxx_init(ctx, rt)
    const result = initFunc(ctxPtr, rtPtr);
    if (result !== 0) {
        throw new Error(`Extension "${ext.name}" init function returned error code ${result}`);
    }
}
/**
 * Re-instantiate extensions for snapshot restore.
 *
 * During restore, we need to:
 * 1. Instantiate extension modules with the same memory/table bases
 * 2. Let them populate the function table (via elem segments and __wasm_apply_data_relocs)
 * 3. Do NOT call the init function (the state is already in the snapshot memory)
 *
 * This reconstructs the function table entries that extensions need, without
 * modifying linear memory (which will be overwritten by the snapshot).
 */
export async function restoreExtensions(descriptors, extensionMeta, mainExports, wasiBuiltins, wasiUserOverrides, memoryProxy) {
    const loaded = [];
    for (const meta of extensionMeta) {
        // Find the descriptor for this extension
        const descriptor = descriptors.find((d) => d.name === meta.name);
        if (!descriptor) {
            throw new Error(`Extension "${meta.name}" required by snapshot but not provided`);
        }
        // Load with fixed bases
        const ext = await loadExtension(descriptor, mainExports, wasiBuiltins, wasiUserOverrides, memoryProxy, {
            memoryBase: meta.memoryBase,
            tableBase: meta.tableBase,
        });
        ext.initFn = meta.initFn;
        loaded.push(ext);
    }
    return loaded;
}
//# sourceMappingURL=extensions.js.map