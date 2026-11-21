import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { configFromEnv, catalog, mockNotification, Store, generate } from '../src/core.js';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vibecopy-test-'));
  const config = configFromEnv({ DATA_DIR: dir });
  const context = createApp(config, options);
  const server = context.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(config.baseUrl + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return response;
  }
  await request('/api/me');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const create = async () => (await (await request('/api/orders', { packId: 'standard' })).json()).order;
  const notify = (order, fields = {}) => request('/api/alipay/notify', mockNotification(order, config, fields));
  return { ...context, config, request, create, notify, dir };
}
test('catalog and order creation use server amounts, reject tampering and empty selection', async t => {
  const f = await fixture(t);
  assert.deepEqual((await (await f.request('/api/me')).json()).catalog, catalog);
  assert.equal((await f.request('/api/orders', { packId: 'standard', total_amount: '0.01' })).status, 400);
  assert.equal((await f.request('/api/orders', { packId: 'invalid' })).status, 400);
  assert.equal((await f.request('/api/orders', {})).status, 400);
  const first = await f.create(), second = await f.create();
  assert.equal(first.amount, '9.90'); assert.notEqual(first.id, second.id); assert.equal(first.status, 'pending');
});
test('valid RSA2 notification grants credits once, including concurrent replay and persisted reload', async t => {
  const f = await fixture(t); const order = await f.create();
  const responses = await Promise.all([f.notify(order), f.notify(order), f.notify(order)]);
  for (const response of responses) assert.equal(await response.text(), 'success');
  assert.equal(f.store.order(order.id).status, 'paid');
  assert.equal((await (await f.request('/api/me')).json()).credits, 20);
  assert.equal(new Store(f.dir).order(order.id).status, 'paid');
  assert.equal(await (await f.notify(order, { trade_status: 'TRADE_FINISHED' })).text(), 'success');
  assert.equal((await (await f.request('/api/me')).json()).credits, 20);
});
test('bad signature, amount mismatch, wrong app, seller, unknown order and unpaid statuses are rejected', async t => {
  const f = await fixture(t); const order = await f.create();
  for (const fields of [{ total_amount: '0.01' }, { app_id: 'wrong' }, { seller_id: 'wrong' }, { out_trade_no: 'missing' }, { trade_status: 'WAIT_BUYER_PAY' }, { trade_no: '' }]) assert.equal((await f.notify(order, fields)).status, 400);
  const invalid = mockNotification(order, f.config); invalid.total_amount = '8.88';
  assert.equal((await f.request('/api/alipay/notify', invalid)).status, 400);
  assert.equal((await f.request('/api/alipay/notify', {})).status, 400);
  assert.equal(f.store.order(order.id).status, 'pending');
  assert.equal((await (await f.request('/api/me')).json()).credits, 0);
});
test('return URL alone cannot mark paid; receipt renders pending and paid fields', async t => {
  const f = await fixture(t); const order = await f.create();
  assert.equal((await f.request(`/payment/return?out_trade_no=${order.id}&trade_status=TRADE_SUCCESS`)).status, 302);
  assert.equal(f.store.order(order.id).status, 'pending');
  assert.match(await (await f.request(`/receipt/${order.id}`)).text(), /等待支付确认/);
  await f.notify(order);
  const html = await (await f.request(`/receipt/${order.id}`)).text();
  for (const field of ['已支付', order.id, `MOCK${order.id}`, '9.90', '标准包', f.store.order(order.id).paidAt]) assert.ok(html.includes(field));
});
test('server query reconciliation validates request and grants once', async t => {
  let result, calls = 0;
  const queryClient = { exec: async (method, params, options) => { calls++; assert.equal(method, 'alipay.trade.query'); assert.equal(params.bizContent.out_trade_no, result.out_trade_no); assert.equal(options.validateSign, true); return result; } };
  const f = await fixture(t, { queryClient }); const order = await f.create();
  result = { code: '10000', out_trade_no: order.id, total_amount: '9.90', trade_no: 'QUERY123', trade_status: 'TRADE_SUCCESS' };
  await f.request(`/payment/return?out_trade_no=${order.id}`);
  await f.request(`/receipt/${order.id}`);
  assert.equal(calls, 1); assert.equal(f.store.order(order.id).status, 'paid');
  assert.equal((await (await f.request('/api/me')).json()).credits, 20);
});
test('query errors and mismatched amounts never grant credits', async t => {
  let result;
  const f = await fixture(t, { queryClient: { exec: async () => { if (!result) throw new Error('offline'); return result; } } });
  const order = await f.create();
  assert.match(await (await f.request(`/receipt/${order.id}`)).text(), /查询暂不可用/);
  result = { code: '10000', out_trade_no: order.id, trade_no: 'BADQUERY', total_amount: '1.00', trade_status: 'TRADE_SUCCESS' };
  await f.request(`/receipt/${order.id}`);
  assert.equal(f.store.order(order.id).status, 'pending');
});
test('credits consumed only on valid generation; insufficient credits and empty input rejected', async t => {
  const f = await fixture(t); const input = { topic: '周末咖啡', channel: '小红书', tone: '温柔治愈' };
  assert.equal((await f.request('/api/generate', input)).status, 402);
  await f.notify(await f.create());
  assert.equal((await f.request('/api/generate', { ...input, topic: '' })).status, 400);
  assert.equal((await f.request('/api/generate', { ...input, channel: 'bad' })).status, 400);
  const response = await (await f.request('/api/generate', input)).json();
  assert.equal(response.credits, 19); assert.match(response.text, /周末咖啡/);
  assert.deepEqual(await generate(input), await generate(input));
});
test('LLM failure and empty response fall back to deterministic templates', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const input = { topic: '咖啡', channel: '朋友圈', tone: '简洁专业' };
  for (const fetcher of [async () => { throw new Error('offline'); }, async () => ({ ok: true, json: async () => ({ choices: [] }) })]) {
    globalThis.fetch = fetcher;
    assert.equal((await generate(input, { base: 'https://example.invalid/v1', key: 'test-only', model: 'test' })).source, '灵感模板');
  }
});
test('order ownership, origin protection, empty orders and health endpoint', async t => {
  const f = await fixture(t); const order = await f.create();
  const other = await fetch(`${f.config.baseUrl}/receipt/${order.id}`); assert.equal(other.status, 404);
  const response = await fetch(`${f.config.baseUrl}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: JSON.stringify({ packId: 'standard' }) });
  assert.equal(response.status, 403);
  assert.match(await (await fetch(`${f.config.baseUrl}/orders`)).text(), /还没有订单/);
  assert.equal((await (await f.request('/healthz')).json()).status, 'ok');
});
