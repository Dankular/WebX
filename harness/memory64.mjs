/**
 * WebX memory64 capability probe.
 *
 * Canary's guest emulation is currently hard-capped at 4 GiB total by the
 * WASM spec — the standard (wasm32) build's single linear memory backs the
 * guest's page-table frame store *and* Canary's own Rust heap / JIT cache /
 * wasm-bindgen tables, all sharing that one 4 GiB address space. The
 * `memory64` WASM proposal (64-bit-indexed linear memory) is the fix in
 * principle, but as of this writing it doesn't buy anything yet — see
 * `../../Canary/docs/memory64-status.md` for the full investigation:
 *
 *   - wasm-bindgen 0.2.111 has no real JS-interop support for the
 *     wasm64-unknown-unknown target (it compiles, but silently exports
 *     nothing useful), so there is no working memory64 Canary build to load.
 *   - Even if there were, Chromium currently clamps a plain webpage's
 *     WebAssembly.Memory to the same 65536-page (4 GiB) ceiling as wasm32
 *     when the memory64 proposal is used, by default policy rather than
 *     spec limit.
 *
 * This module exists so that changes when either of those close instead of
 * needing rediscovery: it answers "does this browser's memory64 support
 * currently permit more than 4 GiB for ordinary web content", cheaply and
 * without committing any real memory (the `maximum` bound on
 * `WebAssembly.Memory` is validated synchronously at construction time, so
 * probing costs nothing). `canary-host.mjs` logs the result at boot and only
 * raises the guest's advertised RAM (`CanaryRuntime.set_guest_ram_bytes`)
 * above Canary's conservative built-in default when the probe confirms
 * there is real headroom to back it.
 */

const WASM32_CEILING_PAGES = 65536; // 4 GiB — the wasm32 hard limit
const PAGE_BYTES = 65536;

/**
 * Probe this browser's memory64 support.
 * @returns {{
 *   indexOption:  boolean,  // WebAssembly.Memory({index:'i64'}) accepted at all
 *   ceilingPages: number,   // largest `maximum` (in 64 KiB pages) accepted
 *   ceilingBytes: number,
 *   beyondWasm32: boolean,  // ceiling exceeds the wasm32 4 GiB cap
 * }}
 */
export function detectMemory64() {
    const result = {
        indexOption:  false,
        ceilingPages: 0,
        ceilingBytes: 0,
        beyondWasm32: false,
    };

    // 1. Does the JS API even accept a 64-bit-indexed memory?
    try {
        new WebAssembly.Memory({ initial: 0, index: 'i64' });
        result.indexOption = true;
    } catch {
        return result; // no memory64 support at all — everything else is moot
    }

    // 2. Probe the actual ceiling this browser currently permits for web
    //    content. Ascending candidates; the constructor validates `maximum`
    //    synchronously without allocating, so this is cheap.
    const candidatePages = [
        WASM32_CEILING_PAGES, //   4 GiB — expected floor (matches wasm32)
        131072,                //   8 GiB
        262144,                //  16 GiB
        1048576,               //  64 GiB
    ];
    let ceiling = 0;
    for (const pages of candidatePages) {
        try {
            new WebAssembly.Memory({ initial: 0, maximum: pages, index: 'i64' });
            ceiling = pages;
        } catch {
            break; // candidates are ascending — first failure is the ceiling
        }
    }

    result.ceilingPages = ceiling;
    result.ceilingBytes = ceiling * PAGE_BYTES;
    result.beyondWasm32  = ceiling > WASM32_CEILING_PAGES;
    return result;
}

/** Human-readable one-line summary for console/status logging. */
export function describeMemory64(info) {
    if (!info.indexOption) return 'memory64: not supported by this browser';
    const gib = (info.ceilingBytes / (1024 ** 3)).toFixed(1);
    return info.beyondWasm32
        ? `memory64: browser permits ${gib} GiB (beyond the wasm32 4 GiB cap) — ` +
          `still needs a working wasm64 Canary build, see Canary/docs/memory64-status.md`
        : `memory64: JS API present but capped at ${gib} GiB, same as wasm32 — no capacity gain available yet`;
}
