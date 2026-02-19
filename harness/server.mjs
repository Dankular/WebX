/**
 * Dev server with required COOP/COEP headers.
 *
 * WebGPU + SharedArrayBuffer both require cross-origin isolation:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Usage: node server.mjs
 */

import { createServer }  from 'node:http';
import { readFile }      from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..');
const PORT = 3000;

const MIME = {
    '.html': 'text/html',
    '.mjs':  'text/javascript',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.wasm': 'application/wasm',
    '.ext2': 'application/octet-stream',
};

createServer(async (req, res) => {
    const url  = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(ROOT, path);

    try {
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
            /* Required for WebGPU + SharedArrayBuffer */
            'Cross-Origin-Opener-Policy':   'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}).listen(PORT, () => {
    console.log(`WebX dev server: http://localhost:${PORT}`);
    console.log('COOP/COEP headers active — WebGPU + SharedArrayBuffer enabled');
});
