import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalog, fail, Store, makeSdk, mockNotification, generate } from './core.js';
import { page, receipt, cashier } from './views.js';

export function createApp(config, { store = new Store(config.dataDir), sdk = makeSdk(config), queryClient = sdk } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' }); next(); });
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser(config.cookieSecret));
  app.get('/healthz', (req, res) => res.json({ status: 'ok', mode: config.mode }));
  app.post('/api/alipay/notify', (req, res) => {
    try {
      if (Object.values(req.body).some(v => typeof v !== 'string') || req.body.sign_type !== 'RSA2' || !sdk.checkNotifySignV2(req.body)) throw fail('签名无效');
      store.settle(req.body, config);
      res.type('text').send('success');
    } catch { res.status(400).type('text').send('failure'); }
  });
  app.use((req, res, next) => {
    req.userId = req.signedCookies.visitor || randomUUID();
    if (!req.signedCookies.visitor) res.cookie('visitor', req.userId, { signed: true, httpOnly: true, sameSite: 'lax', secure: config.mode === 'production', maxAge: 365 * 86400000 });
    if (req.method === 'POST' && req.get('origin') && req.get('origin') !== new URL(config.baseUrl).origin) return next(fail('请求来源无效', 403));
    next();
  });
  app.use('/assets', express.static(fileURLToPath(new URL('../public', import.meta.url))));
  const ownOrder = req => {
    const order = store.order(req.params.id || req.query.out_trade_no);
    if (!order || order.userId !== req.userId) throw fail('找不到订单', 404);
    return order;
  };
  async function reconcile(order) {
    if (order.status === 'paid' || config.mode === 'mock' && queryClient === sdk) return;
    const result = await queryClient.exec('alipay.trade.query', { bizContent: { out_trade_no: order.id } }, { validateSign: true });
    if (result.code === '10000' && ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(result.trade_status)) {
      if (result.out_trade_no !== order.id) throw fail('查询订单不匹配');
      store.settle({ ...result, app_id: config.appId, seller_id: result.seller_id || config.sellerId }, config);
    }
  }
  app.get('/', (req, res) => res.send(page({ config, credits: store.user(req.userId).credits })));
  app.get('/orders', (req, res) => res.send(page({ config, credits: store.user(req.userId).credits, orders: Object.values(store.state.orders).filter(o => o.userId === req.userId).reverse() })));
  app.get('/api/me', (req, res) => res.json({ credits: store.user(req.userId).credits, catalog }));
  app.post('/api/orders', (req, res) => {
    if (Object.keys(req.body).some(k => k !== 'packId')) throw fail('金额由服务端确定，请勿提交额外字段');
    const order = store.create(req.userId, req.body.packId);
    res.status(201).json({ order, payUrl: `/pay/${order.id}` });
  });
  app.get('/pay/:id', (req, res) => {
    const order = ownOrder(req);
    if (order.status === 'paid') return res.redirect(`/receipt/${order.id}`);
    if (config.mode === 'mock') return res.send(cashier(order, config));
    res.send(sdk.pageExec('alipay.trade.page.pay', { notifyUrl: `${config.baseUrl}/api/alipay/notify`, returnUrl: `${config.baseUrl}/payment/return`, bizContent: { out_trade_no: order.id, total_amount: order.amount, subject: `VibeCopy 灵感文案 ${order.pack.name}`, product_code: 'FAST_INSTANT_TRADE_PAY' } }));
  });
  app.post('/mock/confirm/:id', async (req, res) => {
    if (config.mode !== 'mock') throw fail('Not found', 404);
    const order = ownOrder(req);
    const response = await fetch(`${config.baseUrl}/api/alipay/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(mockNotification(order, config)), signal: AbortSignal.timeout(5000) });
    if (!response.ok || await response.text() !== 'success') throw fail('模拟通知失败，请重试', 502);
    res.redirect(303, `/payment/return?out_trade_no=${order.id}`);
  });
  app.get('/payment/return', async (req, res) => {
    const order = ownOrder(req);
    try { await reconcile(order); } catch { /* A return URL is never proof of payment. */ }
    res.redirect(`/receipt/${order.id}`);
  });
  app.get('/receipt/:id', async (req, res) => {
    const order = ownOrder(req);
    let queryError = false;
    try { await reconcile(order); } catch { queryError = true; }
    res.send(receipt(store.order(order.id), config, store.user(req.userId).credits, queryError));
  });
  app.post('/api/generate', async (req, res) => {
    const { topic, channel, tone } = req.body;
    if (typeof topic !== 'string' || !topic.trim() || topic.length > 500 || !['小红书', '朋友圈', '商品文案'].includes(channel) || !['温柔治愈', '活泼有趣', '简洁专业'].includes(tone)) throw fail('请填写主题（1–500 字）并选择文案类型与风格');
    if (store.user(req.userId).credits < 1) throw fail('次数不足，请先购买灵感次数包', 402);
    const input = { topic: topic.trim(), channel, tone };
    const output = await generate(input, config.llm);
    const credits = store.consume(req.userId, input, output);
    res.json({ ...output, credits });
  });
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.status ? err.message : '服务暂时不可用，请稍后重试' }); });
  return { app, store, sdk };
}
