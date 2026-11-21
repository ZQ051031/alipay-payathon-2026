import { randomUUID, generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { AlipaySdk } from 'alipay-sdk';

export const catalog = [
  { id: 'standard', name: '标准包', credits: 20, amount: '9.90' },
  { id: 'advanced', name: '进阶包', credits: 50, amount: '19.90' },
  { id: 'unlimited', name: '畅享包', credits: 120, amount: '39.90' },
];
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function configFromEnv(env = process.env) {
  const mode = env.PAY_MODE || 'mock';
  if (!['mock', 'sandbox', 'production'].includes(mode)) throw fail('Invalid PAY_MODE');
  let privateKey, publicKey;
  if (mode === 'mock') {
    ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }));
  } else {
    privateKey = env.APP_PRIVATE_KEY || (env.APP_PRIVATE_KEY_PATH && readFileSync(env.APP_PRIVATE_KEY_PATH, 'utf8'));
    publicKey = env.ALIPAY_PUBLIC_KEY;
    if (!env.APP_ID || !privateKey || !publicKey || !env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32 || !env.PUBLIC_BASE_URL || !env.SELLER_ID) throw fail('Live modes require APP_ID, private key, ALIPAY_PUBLIC_KEY, SELLER_ID, PUBLIC_BASE_URL and COOKIE_SECRET (32+ characters)');
    if (mode === 'production' && !env.PUBLIC_BASE_URL.startsWith('https://')) throw fail('Production requires HTTPS');
  }
  return { mode, privateKey, publicKey, appId: mode === 'mock' ? 'mock-vibecopy' : env.APP_ID, sellerId: mode === 'mock' ? 'mock-seller' : env.SELLER_ID, cookieSecret: env.COOKIE_SECRET || randomBytes(32).toString('hex'), baseUrl: (env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''), dataDir: resolve(env.DATA_DIR || 'data'), llm: { base: env.LLM_BASE_URL, key: env.LLM_API_KEY, model: env.LLM_MODEL } };
}
export function makeSdk(config) {
  return new AlipaySdk({ appId: config.appId, privateKey: config.privateKey, alipayPublicKey: config.publicKey, signType: 'RSA2', camelcase: false, gateway: config.mode === 'sandbox' ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' : 'https://openapi.alipay.com/gateway.do' });
}
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = resolve(dir, 'store.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { users: {}, orders: {}, generations: [] };
  }
  transaction(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.file);
    this.state = next;
    return result;
  }
  user(id) { return this.state.users[id] || { credits: 0 }; }
  order(id) { return this.state.orders[id]; }
  create(userId, packId) {
    const pack = catalog.find(p => p.id === packId);
    if (!pack) throw fail('请选择有效的次数包');
    return this.transaction(s => {
      const order = { id: `VC${Date.now()}${randomBytes(8).toString('hex')}`, userId, pack: { ...pack }, amount: pack.amount, status: 'pending', createdAt: new Date().toISOString() };
      s.orders[order.id] = order;
      return order;
    });
  }
  settle(fields, config) {
    return this.transaction(s => {
      const order = s.orders[fields.out_trade_no];
      if (!order || fields.app_id !== config.appId || fields.seller_id !== config.sellerId) throw fail('订单或商户不匹配');
      if (!/^\d+(\.\d{1,2})?$/.test(String(fields.total_amount)) || Math.round(Number(fields.total_amount) * 100) !== Math.round(Number(order.amount) * 100)) throw fail('订单金额不匹配');
      if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(fields.trade_status) || !fields.trade_no) throw fail('交易尚未成功');
      if (order.status === 'paid') {
        if (order.tradeNo !== fields.trade_no) throw fail('交易号不匹配');
        return order;
      }
      if (Object.values(s.orders).some(o => o.tradeNo === fields.trade_no)) throw fail('交易号已使用');
      order.status = 'paid'; order.tradeNo = fields.trade_no; order.paidAt = new Date().toISOString();
      s.users[order.userId] ||= { credits: 0 };
      s.users[order.userId].credits += order.pack.credits;
      return order;
    });
  }
  consume(userId, input, output) {
    return this.transaction(s => {
      if (!s.users[userId]?.credits) throw fail('次数不足，请先购买灵感次数包', 402);
      s.users[userId].credits--;
      s.generations.push({ id: randomUUID(), userId, input, output, createdAt: new Date().toISOString() });
      return s.users[userId].credits;
    });
  }
}
export function mockNotification(order, config, overrides = {}) {
  const fields = { app_id: config.appId, seller_id: config.sellerId, out_trade_no: order.id, total_amount: order.amount, trade_status: 'TRADE_SUCCESS', trade_no: `MOCK${order.id}`, ...overrides };
  const canonical = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('&');
  return { ...fields, sign_type: 'RSA2', sign: createSign('RSA-SHA256').update(canonical).sign(config.privateKey, 'base64') };
}
export async function generate(input, llm = {}) {
  const { topic, channel, tone } = input;
  if (llm.base && llm.key && llm.model) {
    try {
      const response = await fetch(`${llm.base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${llm.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: llm.model, messages: [{ role: 'system', content: '你是中文文案助手。只输出文案，不虚构产品功效或事实。' }, { role: 'user', content: `平台：${channel}；风格：${tone}；主题：${topic}` }], max_tokens: 600 }) });
      if (response.ok) {
        const text = (await response.json()).choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text: text.slice(0, 6000), source: 'AI' };
      }
    } catch { /* Template mode remains available offline. */ }
  }
  const openings = { 小红书: '✨ 把日常过成喜欢的样子', 朋友圈: '给今天留一点值得分享的小美好。', 商品文案: '好选择，从看见细节开始。' };
  return { text: `${openings[channel]}\n\n${topic}\n\n${tone === '活泼有趣' ? '灵感叮咚上线！换个角度，发现生活里的小惊喜。' : tone === '简洁专业' ? '关注真实需求，用清晰的表达传递价值。' : '慢一点，感受每个细节。让喜欢的事物，成为日常的温柔注脚。'}\n\n${channel === '小红书' ? '#灵感日常 #生活记录 #发现美好' : channel === '商品文案' ? '了解更多，找到适合自己的那一款。' : '你最近的灵感是什么？'}`, source: '灵感模板' };
}
