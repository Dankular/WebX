/* @ts-self-types="./canary_wasm.d.ts" */

export class CanaryRuntime {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CanaryRuntimeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_canaryruntime_free(ptr, 0);
    }
    /**
     * Add a single file to the virtual filesystem.
     * @param {string} path
     * @param {Uint8Array} data
     */
    add_file(path, data) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.canaryruntime_add_file(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Install the VFS built by `stage_vfs_from_url` into this runtime.
     *
     * Returns `true` if a staged VFS was available and has been merged,
     * `false` if `stage_vfs_from_url` had not been called or already consumed.
     * @returns {boolean}
     */
    apply_staged_vfs() {
        const ret = wasm.canaryruntime_apply_staged_vfs(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Return the current thread ID (used by the Worker harness to verify state).
     * @returns {number}
     */
    current_tid() {
        const ret = wasm.canaryruntime_current_tid(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Drain any pending `clone` requests and return them as a JSON array.
     *
     * Each element has the shape:
     * `{"tid":2,"child_stack":12345678,"tls":87654321,"child_tidptr":99,"flags":1234}`
     *
     * The JS harness should call this after every `step()` (or batch of steps)
     * and spawn a Web Worker for each entry, passing in the data so the Worker
     * can set up RSP = child_stack, fs_base = tls, and RAX = 0 (child return).
     * @returns {string}
     */
    drain_clone_requests() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.canaryruntime_drain_clone_requests(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Drain any pending connect() requests.
     *
     * Returns a JSON array of `{"fd":N,"ip":"a.b.c.d","port":P}` objects.
     * JS should open a WebSocket to `ws://ip:port` for each entry, then call
     * `socket_connected(fd)` when the WebSocket opens and
     * `socket_recv_data(fd, bytes)` when data arrives.
     * @returns {string}
     */
    drain_connect_requests() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.canaryruntime_drain_connect_requests(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Drain all I/O port writes from the guest as JSON.
     * Format: [{"port":0x7860,"size":4,"val":305419896}, ...]
     * @returns {string}
     */
    drain_io_writes() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.canaryruntime_drain_io_writes(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Drain all pending Tier-1 WASM compilations queued since the last call.
     *
     * Returns a JS Array of {rip, wasm: Uint8Array} objects.
     * Call this from the JS step loop, compile each entry with
     * new WebAssembly.Module(wasm), instantiate with wasm_memory as the
     * env.memory import, and register via register_compiled_block.
     * @returns {any}
     */
    drain_jit_queue() {
        const ret = wasm.canaryruntime_drain_jit_queue(this.__wbg_ptr);
        return ret;
    }
    /**
     * Drain any pending outbound socket data.
     *
     * Returns a JSON array of `{"fd":N,"data":"<base64>"}` objects.
     * JS should forward each chunk over the corresponding WebSocket.
     * @returns {string}
     */
    drain_socket_sends() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.canaryruntime_drain_socket_sends(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Read bytes from the stderr capture buffer and clear it.
     * @returns {Uint8Array}
     */
    drain_stderr() {
        const ret = wasm.canaryruntime_drain_stderr(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Read bytes from the stdout capture buffer and clear it.
     * @returns {Uint8Array}
     */
    drain_stdout() {
        const ret = wasm.canaryruntime_drain_stdout(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Drain the list of paths that triggered ENOENT since the last call.
     * The JS harness calls this each frame to lazily fetch missing files.
     * @returns {Array<any>}
     */
    drain_vfs_misses() {
        const ret = wasm.canaryruntime_drain_vfs_misses(this.__wbg_ptr);
        return ret;
    }
    /**
     * Return a JSON object with all GPR values (for debugging).
     * @returns {string}
     */
    dump_regs_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.canaryruntime_dump_regs_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Emit WASM bytecode for the basic block at `entry_rip`.
     *
     * Returns the raw WASM module binary, or an empty Vec if the block could
     * not be compiled or contains instructions not yet supported by the
     * Tier-1 emitter.
     *
     * JS calls `WebAssembly.compile()` on the returned bytes and then calls
     * `mark_jit_compiled(entry_rip)` to record that Tier-1 is ready.
     * @param {bigint} entry_rip
     * @returns {Uint8Array}
     */
    emit_jit_block(entry_rip) {
        const ret = wasm.canaryruntime_emit_jit_block(this.__wbg_ptr, entry_rip);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Returns framebuffer dimensions as the string "{width},{height}".
     * @returns {string}
     */
    get_fb_dimensions() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.canaryruntime_get_fb_dimensions(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns the current framebuffer pixel data as a flat BGRA Uint8Array.
     * Returns an empty Vec if the framebuffer has not been mmap'd by the guest yet.
     * @returns {Uint8Array}
     */
    get_framebuffer() {
        const ret = wasm.canaryruntime_get_framebuffer(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Return the current FS segment base (TLS pointer) for debugging.
     * @returns {bigint}
     */
    get_fs_base() {
        const ret = wasm.canaryruntime_get_fs_base(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Returns true if the guest has mmap'd /dev/fb0.
     * @returns {boolean}
     */
    has_framebuffer() {
        const ret = wasm.canaryruntime_has_framebuffer(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Initialize a thread Worker's register state.
     * Called from a Web Worker after `restore_pages()`, before run.
     * Sets RIP, RSP, FS base, and writes tid to child_tidptr.
     * @param {bigint} child_stack
     * @param {bigint} tls
     * @param {bigint} child_tidptr
     * @param {bigint} rip
     */
    init_thread(child_stack, tls, child_tidptr, rip) {
        wasm.canaryruntime_init_thread(this.__wbg_ptr, child_stack, tls, child_tidptr, rip);
    }
    /**
     * List directory entries as a JSON array of {name, kind} objects.
     * @param {string} path
     * @returns {string}
     */
    list_dir(path) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.canaryruntime_list_dir(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Load a filesystem image (raw ext2 image bytes).
     * Populates the virtual filesystem from the image.
     * @param {Uint8Array} data
     */
    load_fs_image(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.canaryruntime_load_fs_image(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Mark the basic block at `entry_rip` as having a Tier-1 compiled WASM
     * module ready for execution.
     *
     * JS calls this after `WebAssembly.compile()` succeeds on the bytes
     * returned by `emit_jit_block()`.  Returns `true` if the block was found
     * in the JIT cache and promoted, `false` otherwise.
     * @param {bigint} entry_rip
     * @returns {boolean}
     */
    mark_jit_compiled(entry_rip) {
        const ret = wasm.canaryruntime_mark_jit_compiled(this.__wbg_ptr, entry_rip);
        return ret !== 0;
    }
    /**
     * Create a new Canary runtime instance.
     */
    constructor() {
        const ret = wasm.canaryruntime_new();
        this.__wbg_ptr = ret >>> 0;
        CanaryRuntimeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Check if a path exists in the VFS.
     * @param {string} path
     * @returns {boolean}
     */
    path_exists(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.canaryruntime_path_exists(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Prepare an ELF binary for incremental execution via step().
     *
     * Unlike run_elf(), this does NOT enter the interpreter loop.
     * It parses the ELF, resets CPU/memory, loads segments, sets up the
     * stack and auxv, and positions RIP at the entry point — then returns.
     * Call step() in a requestAnimationFrame loop to drive execution.
     *
     * Returns true on success, false if setup fails (check console for error).
     * @param {Uint8Array} elf_bytes
     * @param {string} argv_json
     * @param {string} envp_json
     * @returns {boolean}
     */
    prepare_elf(elf_bytes, argv_json, envp_json) {
        const ptr0 = passArray8ToWasm0(elf_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(argv_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(envp_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.canaryruntime_prepare_elf(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        return ret !== 0;
    }
    /**
     * Push an I/O port read response (JS to guest).
     * Call this before the guest's next IN instruction.
     * @param {number} port
     * @param {number} size
     * @param {number} val
     */
    push_io_read(port, size, val) {
        wasm.canaryruntime_push_io_read(this.__wbg_ptr, port, size, val);
    }
    /**
     * Push a keyboard event from JS.
     * `code` is the browser KeyboardEvent.code string (e.g., "KeyA", "Space").
     * `pressed` is true for keydown, false for keyup.
     * @param {string} code
     * @param {boolean} pressed
     */
    push_key_event(code, pressed) {
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.canaryruntime_push_key_event(this.__wbg_ptr, ptr0, len0, pressed);
    }
    /**
     * Push a mouse button event.
     * `button`: 0=left, 1=middle, 2=right (browser convention).
     * `pressed`: true=down, false=up.
     * @param {number} button
     * @param {boolean} pressed
     */
    push_mouse_button(button, pressed) {
        wasm.canaryruntime_push_mouse_button(this.__wbg_ptr, button, pressed);
    }
    /**
     * Push a mouse motion event.
     * `x`, `y` are canvas-relative pixel coordinates (will be converted to relative deltas).
     * @param {number} x
     * @param {number} y
     */
    push_mouse_move(x, y) {
        wasm.canaryruntime_push_mouse_move(this.__wbg_ptr, x, y);
    }
    /**
     * Read a file from the virtual filesystem.
     * Returns the file content as a Uint8Array, or null if not found.
     * @param {string} path
     * @returns {Uint8Array | undefined}
     */
    read_file(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.canaryruntime_read_file(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Read a 64-bit little-endian value from guest memory (for debugging).
     * Returns 0 if the address is not mapped.
     * @param {bigint} addr
     * @returns {bigint}
     */
    read_mem_u64(addr) {
        const ret = wasm.canaryruntime_read_mem_u64(this.__wbg_ptr, addr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Register a compiled Tier-1 block function returned by JS after
     * WebAssembly.Instance.
     *
     * run_fn must be the run export of an instance created from the WASM
     * bytes emitted for rip.  It will be called as run(reg_ptr, 0) where
     * reg_ptr (i32) is the WASM linear memory offset of cpu.gpr[0].
     * Returns an i32 exit code: 0=continue, 1=syscall.
     * @param {number} rip
     * @param {any} run_fn
     */
    register_compiled_block(rip, run_fn) {
        wasm.canaryruntime_register_compiled_block(this.__wbg_ptr, rip, run_fn);
    }
    /**
     * Restore guest memory from a blob produced by the parent's `snapshot_pages()`.
     * Must be called before `init_thread()`.
     * @param {Uint8Array} blob
     * @returns {boolean}
     */
    restore_pages(blob) {
        const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.canaryruntime_restore_pages(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Return current program counter (RIP on x86-64, PC on AArch64).
     * @returns {bigint}
     */
    rip() {
        const ret = wasm.canaryruntime_rip(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Load and execute a 64-bit ELF binary.
     *
     * `argv` is a JSON array of strings: `["./prog", "arg1", "arg2"]`
     * `envp` is a JSON array of strings: `["HOME=/root", "PATH=/usr/bin"]`
     *
     * Returns the exit code.
     * @param {Uint8Array} elf_bytes
     * @param {string} argv_json
     * @param {string} envp_json
     * @returns {number}
     */
    run_elf(elf_bytes, argv_json, envp_json) {
        const ptr0 = passArray8ToWasm0(elf_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(argv_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(envp_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.canaryruntime_run_elf(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        return ret;
    }
    /**
     * Set the current thread ID.  Called by the Worker harness when initialising
     * a spawned thread so that `gettid()` returns the correct value.
     * @param {number} tid
     */
    set_current_tid(tid) {
        wasm.canaryruntime_set_current_tid(this.__wbg_ptr, tid);
    }
    /**
     * Set/update the working directory.
     * @param {string} path
     */
    set_cwd(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.canaryruntime_set_cwd(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Snapshot all mapped guest pages into a transferable binary blob.
     * Pass this blob to a Worker's `restore_pages()` so the child thread
     * starts with the same address space as the parent.
     * @returns {Uint8Array}
     */
    snapshot_pages() {
        const ret = wasm.canaryruntime_snapshot_pages(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Called from JS when a connect() WebSocket successfully opens.
     * Transitions the socket from `Connecting` to `Connected`.
     * @param {bigint} fd
     */
    socket_connected(fd) {
        wasm.canaryruntime_socket_connected(this.__wbg_ptr, fd);
    }
    /**
     * Called from JS when data arrives on a socket's WebSocket.
     * Appends data to the socket's receive buffer so that `recvfrom` can read it.
     * @param {bigint} fd
     * @param {Uint8Array} data
     */
    socket_recv_data(fd, data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.canaryruntime_socket_recv_data(this.__wbg_ptr, fd, ptr0, len0);
    }
    /**
     * Execute a single instruction step.  Returns false when the program ends.
     * @returns {boolean}
     */
    step() {
        const ret = wasm.canaryruntime_step(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Return the WASM linear memory so JS can instantiate compiled JIT blocks
     * with the correct memory import.
     * @returns {any}
     */
    static wasm_memory() {
        const ret = wasm.canaryruntime_wasm_memory();
        return ret;
    }
    /**
     * Write a 64-bit little-endian value to guest memory (for debugging/patching).
     * Returns true on success, false if the address is not mapped.
     * @param {bigint} addr
     * @param {bigint} val
     * @returns {boolean}
     */
    write_mem_u64(addr, val) {
        const ret = wasm.canaryruntime_write_mem_u64(this.__wbg_ptr, addr, val);
        return ret !== 0;
    }
    /**
     * Write bytes into the stdin buffer.
     * @param {Uint8Array} data
     */
    write_stdin(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.canaryruntime_write_stdin(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) CanaryRuntime.prototype[Symbol.dispose] = CanaryRuntime.prototype.free;

/**
 * Fetch the raw content of a file from the ext2 image by its VFS path.
 *
 * Returns the file bytes as a `Uint8Array`, or rejects if the path is unknown
 * or the network fetch fails.  The ext2 reader and inode map are populated by
 * `stage_vfs_from_url` and remain available until the page is unloaded.
 * @param {string} path
 * @returns {Promise<Uint8Array>}
 */
export function fetch_ext2_file(path) {
    const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fetch_ext2_file(ptr0, len0);
    return ret;
}

/**
 * Look up a single path in the ext2 image and return its content.
 *
 * Unlike `fetch_ext2_file`, this does NOT require the path to have been
 * indexed during `stage_vfs_from_url` — it walks the directory tree on
 * demand starting from the ext2 root.
 *
 * Returns `undefined` (not an error) if the path does not exist in the image.
 * @param {string} path
 * @returns {Promise<Uint8Array>}
 */
export function lookup_ext2_path(path) {
    const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.lookup_ext2_path(ptr0, len0);
    return ret;
}

/**
 * Traverse the ext2/ext4 image at `url` via HTTP Range requests and build a
 * MemFs in the thread-local staging area.
 *
 * Call `rt.apply_staged_vfs()` after this completes to install the result.
 *
 * This is a free async function (not a method) because wasm-bindgen does not
 * support `async fn` on `&mut self` struct methods.
 * @param {string} url
 * @returns {Promise<void>}
 */
export function stage_vfs_from_url(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.stage_vfs_from_url(ptr0, len0);
    return ret;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_18bea6e84080c016: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_undefined_4a711ea9d2e1ef93: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_memory_6ff80552d51b4e93: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_number_get_eed4462ef92e1bed: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_throw_df03e93053e0f4bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_9f02ce912168c354: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_apply_a87a4a7e4cedccd4: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.apply(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_arrayBuffer_6881d775e5087c3c: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_call_85e5437fa1ab109d: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_error_d0479ba22fd975af: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_fetch_ec775423198d5d5c: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_headers_9924a8770a24d779: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_instanceof_Response_4d70bea95d48a514: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_0cc62e4f32542cc4: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_5e07cf181b2745fb: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_log_3800275a8de8b5d4: function(arg0, arg1) {
            console.log(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_62f131e968c83d75: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_66075f8c2ea6575e: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_a0479da6258a0d71: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_from_slice_e98c2bb0a59c32a0: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_893dbec5fe999814: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h15ef86b6276c0687(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = state0.b = 0;
            }
        },
        __wbg_new_with_length_9b57e4a9683723fa: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_str_and_init_ccd7de5a7b7630b8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_of_d5e6c8fdf4ead97d: function(arg0, arg1) {
            const ret = Array.of(arg0, arg1);
            return ret;
        },
        __wbg_prototypesetcall_d1a7133bc8d83aa9: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_960865cda81df836: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_622e69f0935dfab2: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_d0528786d26e067c: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_resolve_d170483d75a2c8a1: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_set_8326741805409e83: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_db2c2258160ed058: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.set(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_set_method_e1291768ddb1e35e: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_1fcb26983836e884: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_static_accessor_GLOBAL_THIS_6614f2f4998e3c4c: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_d8e8a2fefe80bc1d: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_e29eaf7c465526b1: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_66e7ca3eef30585a: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_3a65028f4384d918: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_then_1170ade08ea65bc7: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_fdc17de424bf508a: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_warn_44a004bea901c1a0: function(arg0, arg1) {
            console.warn(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { dtor_idx: 119, function: Function { arguments: [Externref], shim_idx: 120, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h2f512679e1c7bb04, wasm_bindgen__convert__closures_____invoke__h3b15c017cfe8939b);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./canary_wasm_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__h3b15c017cfe8939b(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h3b15c017cfe8939b(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h15ef86b6276c0687(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h15ef86b6276c0687(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const CanaryRuntimeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_canaryruntime_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('canary_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
