/**
 * Playwright boot monitor — connects to WebX, clicks Launch, streams console.
 * Usage: node playwright-boot.mjs [url]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'https://ns3113582.ip-54-37-252.eu/play/';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const browser = await chromium.launch({
    headless: false,
    args: [
        '--ignore-certificate-errors',
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,WebGPU',
        '--use-angle=default',
    ],
});

const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
});

const page = await ctx.newPage();

// Stream all console messages
page.on('console', msg => {
    const type = msg.type().toUpperCase().padEnd(5);
    console.log(`[${type}] ${msg.text()}`);
});

page.on('pageerror', err => {
    console.error(`[PGERR] ${err.message}`);
});

page.on('requestfailed', req => {
    console.error(`[FAIL ] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
});

console.log(`Navigating to ${URL} ...`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Click Launch button once it's enabled
console.log('Waiting for Launch button...');
const btn = page.locator('#launch-btn');
await btn.waitFor({ state: 'visible', timeout: 15000 });
await btn.waitFor({ state: 'attached', timeout: 15000 });

// Poll until not disabled
for (let i = 0; i < 30; i++) {
    const disabled = await btn.isDisabled();
    if (!disabled) break;
    await page.waitForTimeout(500);
}

console.log('Clicking Launch...');
await btn.click();

// Wait and keep streaming logs
console.log(`Running for up to ${TIMEOUT_MS / 1000}s — press Ctrl+C to stop early\n`);
await page.waitForTimeout(TIMEOUT_MS);

await browser.close();
