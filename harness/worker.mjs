/**
 * worker.mjs — Web Worker for Canary guest thread execution.
 *
 * Each guest clone() spawns one of these Workers. It creates its own
 * CanaryRuntime, sets up the child thread register state, then runs
 * step() in setTimeout slices to avoid blocking the Worker event loop.
 *
 * I/O port (GPU bridge) and networking stay on the main thread.
 * Workers forward stdout, stderr, and nested clone() requests to main.
 *
 * Message protocol (main → worker):
 *   { type: 'init', wasmModule: WebAssembly.Module|null,
 *     sharedMemory: WebAssembly.Memory|null,  — non-null with pkg-threads build only
 *     tid: number, childStack: number, tls: number, childTidptr: number }
 *   { type: 'run' }
 *   { type: 'stop' }
 *
 * Message protocol (worker → main):
 *   { type: 'ready' }
 *   { type: 'stdout', data: Uint8Array }
 *   { type: 'stderr', data: Uint8Array }
 *   { type: 'clone',  requests: string }   — JSON array of CloneInfo
 *   { type: 'exit',   code: number }
 */

const CANARY_WASM_URL = '/canary/canary_wasm.js';

/* Steps to execute per setTimeout slice before yielding back to the event loop. */
const STEPS_PER_SLICE = 1000;

let rt      = null;
let running = false;

self.onmessage = async (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'init': {
            try {
                const wasmJs = await import(CANARY_WASM_URL);

                if (msg.wasmModule && msg.sharedMemory) {
                    /*
                     * pkg-threads build: initialise with the pre-compiled module
                     * AND the SharedArrayBuffer-backed memory from the main thread.
                     * Both Workers see the same guest address space (CLONE_VM).
                     */
                    await wasmJs.default(msg.wasmModule, msg.sharedMemory);
                } else if (msg.wasmModule) {
                    /* Standard build: reuse compiled module, isolated memory. */
                    await wasmJs.default(msg.wasmModule);
                } else {
                    /* No cached module — compile independently (slower first start). */
                    await wasmJs.default();
                }

                const { CanaryRuntime } = wasmJs;
                rt = new CanaryRuntime();

                /* Set the TID so gettid() returns the right value inside the guest. */
                rt.set_current_tid(msg.tid);

                /*
                 * Initialise the child thread's CPU state:
                 *   childStack → RSP  (the stack pointer the parent set up for us)
                 *   tls        → FS base (TLS pointer passed in clone() flags)
                 *   childTidptr → memory address where the kernel writes our TID
                 */
                rt.init_thread(
                    BigInt(msg.childStack),
                    BigInt(msg.tls),
                    BigInt(msg.childTidptr),
                );

                self.postMessage({ type: 'ready' });
            } catch (e) {
                console.error('[worker] init failed:', e);
                self.postMessage({ type: 'exit', code: -1 });
            }
            break;
        }

        case 'run': {
            if (!rt) return;
            running = true;

            function runSlice() {
                if (!running || !rt) return;

                /* Execute a batch of instructions. */
                for (let i = 0; i < STEPS_PER_SLICE && running; i++) {
                    if (!rt.step()) {
                        running = false;
                        break;
                    }
                }

                /* Flush output to main thread. */
                const stdout = rt.drain_stdout();
                if (stdout.length > 0)
                    self.postMessage({ type: 'stdout', data: stdout });

                const stderr = rt.drain_stderr();
                if (stderr.length > 0)
                    self.postMessage({ type: 'stderr', data: stderr });

                /* Forward any nested clone() requests. */
                const clones = rt.drain_clone_requests();
                if (clones !== '[]')
                    self.postMessage({ type: 'clone', requests: clones });

                if (running) {
                    setTimeout(runSlice, 0);
                } else {
                    self.postMessage({ type: 'exit', code: 0 });
                }
            }

            setTimeout(runSlice, 0);
            break;
        }

        case 'stop': {
            running = false;
            break;
        }
    }
};
