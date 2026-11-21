import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/core.js';

mkdirSync('artifacts', { recursive: true });
const dataDir = mkdtempSync(resolve('artifacts/smoke-data-'));
const config = configFromEnv({ PAY_MODE: 'mock', DATA_DIR: dataDir });
const { app } = createApp(config);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
config.baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const executablePath = process.env.CHROME_PATH || execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim();
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  await page.goto(config.baseUrl);
  await page.screenshot({ path: 'artifacts/home.png', fullPage: true });
  await page.getByRole('button', { name: '选择标准包' }).click();
  await page.getByRole('heading', { name: '模拟收银台' }).waitFor();
  await page.getByRole('button', { name: '确认模拟支付 ¥9.90' }).click();
  await page.waitForURL('**/receipt/**');
  await page.getByRole('heading', { name: '已支付，灵感已就位。' }).waitFor();
  assert.equal(await page.locator('[data-credits]').first().textContent(), '20');
  await page.screenshot({ path: 'artifacts/receipt.png', fullPage: true });
  await page.getByRole('link', { name: '开始创作 →' }).click();
  await page.getByLabel('描述你的灵感').fill('周末露营的便携咖啡杯，轻巧、有质感');
  await page.getByRole('button', { name: '生成我的灵感文案' }).click();
  await page.locator('#output').waitFor({ state: 'visible' });
  assert.match(await page.locator('#output').textContent(), /便携咖啡杯/);
  assert.equal(await page.locator('[data-credits]').first().textContent(), '19');
  await page.screenshot({ path: 'artifacts/generated.png', fullPage: true });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(config.baseUrl);
  await mobile.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS: home → standard pack → RSA2 mock notify → paid receipt → generation → credits 20 → 19');
  console.log('Screenshots: artifacts/home.png, artifacts/receipt.png, artifacts/generated.png, artifacts/mobile.png');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
