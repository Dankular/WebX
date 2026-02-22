/**
 * Dev server with required COOP/COEP headers.
 *
 * WebGPU + SharedArrayBuffer both require cross-origin isolation:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Also supports HTTP Range requests (RFC 7233) for on-demand block fetching
 * of the SteamOS ext2 image.
 *
 * URL routing:
 *   /               → harness/index.html
 *   /steam/*        → ../steam/*    (large disk images, served with range support)
 *   /canary/*       → CANARY_PKG/*  (Canary WASM package — canary_wasm.js + .wasm)
 *   /*              → harness/*     (JS modules, HTML, etc.)
 *
 * Set CANARY_PKG env var to override the default Canary package path.
 * Default assumes Canary repo is a sibling of the SteamWeb directory:
 *   D:\Dev Proj\Canary\crates\canary-wasm\pkg
 *
 * Usage: node server.mjs
 */

import { createServer }                   from 'node:http';
import { createReadStream }               from 'node:fs';
import { stat }                           from 'node:fs/promises';
import { extname, join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath }                  from 'node:url';

const HARNESS   = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(HARNESS, '..'));
const PORT      = 3000;

/* Path to the Canary wasm-pack output directory.
 * Default: sibling repo at ../../Canary/crates/canary-wasm/pkg relative to WebX root.
 * Override with CANARY_PKG environment variable. */
const CANARY_PKG = process.env.CANARY_PKG
    ?? resolve(REPO_ROOT, '..', '..', 'Canary', 'crates', 'canary-wasm', 'pkg');

const MIME = {
    '.html': 'text/html',
    '.mjs':  'text/javascript',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.ext2': 'application/octet-stream',
};

const CORS = {
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
};

/* Allowed filesystem roots — restrict path traversal */
const ALLOWED_ROOTS = [
    resolve(HARNESS),
    resolve(join(REPO_ROOT, 'steam')),
    resolve(CANARY_PKG),
];

function isAllowed(realPath) {
    return ALLOWED_ROOTS.some(r => realPath.startsWith(r + sep) || realPath === r);
}

createServer(async (req, res) => {
    const url  = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    /* URL → filesystem */
    let file;
    if (path === '/') {
        file = join(HARNESS, 'index.html');
    } else if (path.startsWith('/steam/')) {
        /* Disk images live in steam/ */
        file = join(REPO_ROOT, path);
    } else if (path.startsWith('/canary/')) {
        /* Canary WASM package: canary_wasm.js + canary_wasm_bg.wasm */
        file = join(CANARY_PKG, path.slice('/canary/'.length));
    } else {
        file = join(HARNESS, path);
    }

    const realFile = resolve(file);
    if (!isAllowed(realFile)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    /* Silence browser favicon requests */
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    let fileStat;
    try { fileStat = await stat(realFile); }
    catch { res.writeHead(404); res.end('Not found'); return; }

    const contentType  = MIME[extname(realFile)] ?? 'application/octet-stream';
    const lastModified = fileStat.mtime.toUTCString();  /* Required by HttpBytesDevice */
    const rangeHeader  = req.headers['range'];

    if (rangeHeader) {
        /* ── Range request (RFC 7233) ─────────────────────────────────────
         * Canary fetches ext2 image blocks on demand using Range: bytes=start-end.
         * Must respond 206 Partial Content (not 200), with Last-Modified for validation.
         */
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!match) { res.writeHead(400); res.end('Bad Range'); return; }

        const fileSize = fileStat.size;
        const start    = match[1] ? parseInt(match[1], 10) : 0;
        const end      = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1)
                                  : fileSize - 1;

        if (start > end || start >= fileSize) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            res.end(); return;
        }

        res.writeHead(206, {
            ...CORS,
            'Content-Type':   contentType,
            'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges':  'bytes',
            'Last-Modified':  lastModified,
        });
        createReadStream(realFile, { start, end }).pipe(res);

    } else {
        /* ── Normal (non-range) response ─────────────────────────────────
         * Stream the file to avoid loading multi-GB images into memory.
         */
        res.writeHead(200, {
            ...CORS,
            'Content-Type':   contentType,
            'Content-Length': String(fileStat.size),
            'Accept-Ranges':  'bytes',
            'Last-Modified':  lastModified,
        });
        createReadStream(realFile).pipe(res);
    }

}).listen(PORT, () => {
    console.log(`WebX dev server:  http://localhost:${PORT}`);
    console.log('COOP/COEP headers: active (WebGPU + SharedArrayBuffer enabled)');
    console.log(`Guest image:      ${join(REPO_ROOT, 'steam', 'steamos-webx.ext2')}`);
    console.log(`Canary WASM pkg:  ${CANARY_PKG}`);
});
