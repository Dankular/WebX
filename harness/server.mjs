/**
 * Dev server with required COOP/COEP headers.
 *
 * WebGPU + SharedArrayBuffer both require cross-origin isolation:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Also supports HTTP Range requests (RFC 7233) so CheerpX HttpBytesDevice
 * can fetch the 12 GB SteamOS ext2 image on demand, block by block.
 *
 * URL routing:
 *   /               → harness/index.html
 *   /steam/*        → ../steam/*    (large disk images, served with range support)
 *   /*              → harness/*     (JS modules, HTML, etc.)
 *
 * Usage: node server.mjs
 */

import { createServer }                   from 'node:http';
import { createReadStream }               from 'node:fs';
import { stat }                           from 'node:fs/promises';
import { extname, join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath }                  from 'node:url';

const HARNESS  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(HARNESS, '..'));
const PORT     = 3000;

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
        /* Disk images live one directory up, in steam/ */
        file = join(REPO_ROOT, path);
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
         * CheerpX HttpBytesDevice fetches blocks on demand using Range: bytes=start-end.
         * We must respond 206 Partial Content, not 200, or CheerpX will reject it.
         * HttpBytesDevice also requires Last-Modified or ETag to validate the image.
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
    console.log(`WebX dev server: http://localhost:${PORT}`);
    console.log('COOP/COEP headers: active (WebGPU + SharedArrayBuffer enabled)');
    console.log(`Guest image:       ${join(REPO_ROOT, 'steam', 'steamos-rootfs.ext2')}`);
});
