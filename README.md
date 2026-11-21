# VibeCopy 灵感文案 · 支付宝 AI付 PAYATHON 2026（Vibe Pay 赛道）

[中文](#中文) · [English](#english)

> 本仓库默认运行在 **mock（本地模拟）** 或 **支付宝沙箱** 模式，不包含任何真实商户凭证，不会产生真实扣款。
> This repo runs in **mock** or **Alipay sandbox** mode by default. It contains no real merchant credentials and never charges real money.

---

## 中文

### 产品想法
VibeCopy 是一个 AI 文案工作台：输入主题、选择渠道（小红书 / 朋友圈 / 商品详情）和语气，一键生成可直接发布的文案。
收费采用 Vibe Pay 官方推荐的 **次数包** 模式：

| 档位 | 权益 | 价格 |
| --- | --- | --- |
| 标准包 | 20 次生成 | ¥9.90 |
| 进阶包 | 50 次生成 | ¥19.90 |
| 畅享包 | 120 次生成 | ¥39.90 |

用户先购买次数包，通过支付宝网页支付（`alipay.trade.page.pay`，`FAST_INSTANT_TRADE_PAY`）付款，服务端验签确认后到账，每次生成核销 1 次。

### 目标用户
- 小红书博主、个体店主、微商和小商家：需要每天产出大量营销文案，但不想订阅昂贵的月费工具。
- 学生与自由职业者：按次付费、用多少买多少。

### 支付链路
浏览次数包 → 选择 → 服务端创建订单（金额只取服务端目录，`out_trade_no` 由服务端生成）→ 跳转支付宝收银台 → 支付宝异步通知 `/api/alipay/notify`（RSA2 验签 + 校验 `app_id`、`seller_id`、`out_trade_no`、`total_amount`、`trade_status`，幂等入账）→ 同步返回 `/payment/return`（不信任返回参数，待支付时主动调用 `alipay.trade.query` 对账）→ 收据页 `/receipt/:id` → 订单列表 `/orders` → 使用次数生成文案。

依据官方文档：支付结果只以**验签通过的异步通知**或**交易查询接口**为准，绝不只依赖同步跳转。

### 运行
需要 Node.js 22。
```bash
npm ci
cp .env.example .env      # 可选；默认 PAY_MODE=mock
npm start                 # http://127.0.0.1:3000
npm test                  # 单元/集成测试
npm run smoke             # 无头 Chrome 端到端冒烟测试（需本机安装 google-chrome，可用 CHROME_PATH 指定）
```

### 三种支付模式（`PAY_MODE`）
| 模式 | 网关 | 凭证 | 用途 |
| --- | --- | --- | --- |
| `mock`（默认） | 本地模拟收银台 | 启动时生成的临时 RSA2 测试密钥 | 无凭证演示；模拟通知走与真实环境完全相同的验签代码 |
| `sandbox` | `https://openapi-sandbox.dl.alipaydev.com/gateway.do` | 支付宝开放平台沙箱应用 | 联调测试 |
| `production` | `https://openapi.alipay.com/gateway.do` | 真实商户应用（须 HTTPS） | 正式收款（比赛按真实付费订单评选） |

### 从沙箱切换到真实商户凭证
1. 本人在支付宝完成实名认证，并按 [Vibe Pay 网页应用收款接入](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/ai-web-app-payment-integration-guide.md) 开通「AI 网页应用收款」/ 电脑网站支付并签约入驻（AI付官网控制台或开放平台）。
2. 在开放平台创建应用，配置 RSA2 密钥：保存**应用私钥**（只放服务器，不进仓库），获取**支付宝公钥**、`APP_ID` 和商户 PID（`SELLER_ID`，2088 开头）。
3. 部署到可公网访问的 HTTPS 域名（网站需按要求备案），在 `.env` 中设置：
   ```env
   PAY_MODE=production
   PUBLIC_BASE_URL=https://你的域名
   COOKIE_SECRET=<32 位以上随机串>
   APP_ID=<正式 APP_ID>
   APP_PRIVATE_KEY_PATH=/安全路径/app_private_key.pem
   ALIPAY_PUBLIC_KEY=<支付宝公钥>
   SELLER_ID=<2088...>
   ```
4. 先用沙箱跑通一笔：`PAY_MODE=sandbox` + 沙箱应用的 APP_ID/密钥/沙箱买家账号。再切到 `production` 用小额真实订单自测，确认异步通知能到达 `/api/alipay/notify`。
5. 生产私钥、`.env` 永远不要提交到仓库。

### 可选：接入大模型
设置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`（OpenAI 兼容接口）。未配置或调用失败时自动回退到内置模板引擎；只有成功生成才扣次数。

### 演示步骤
1. `npm start`，打开 http://127.0.0.1:3000 ，顶部显示「MOCK DEMO」与剩余次数 0。
2. 在「灵感次数包」选择 **标准包 ¥9.90**，点击购买。
3. 进入收银台（mock 模式为标注清楚的「模拟收银台」；sandbox 模式为支付宝沙箱收银台，用沙箱买家账号付款）。
4. 确认支付 → 服务端收到签名通知并验签 → 跳转收据页，显示「已支付」、商户订单号、支付宝交易号、金额、时间。
5. 回到「创作工作台」，输入主题并生成文案，剩余次数 20 → 19。
6. 「我的订单」查看订单记录。

### 项目结构
```
src/server.js   启动与 dotenv
src/app.js      Express 路由、签名 Cookie、验签与对账
src/core.js     次数包目录、配置与 SDK、JSON 账本、mock 签名、文案生成
src/views.js    服务端渲染页面（已转义）
public/         前端样式与交互
test/           支付 / 安全 / 次数测试
scripts/smoke.js 无头 Chrome 端到端测试
```
数据保存在 `data/`（JSON 文件，单进程）。正式上线建议换成数据库并加限流、监控与备份。

---

## English

### Product idea
VibeCopy is an AI copywriting studio: enter a topic, pick a channel (Xiaohongshu / WeChat Moments / product page) and a tone, and get ready-to-post copy. It is monetised with the **credit pack** model recommended by Vibe Pay: Standard 20 generations ¥9.90, Advanced 50 ¥19.90, Unlimited-ish 120 ¥39.90. Users buy a pack, pay with Alipay web payment (`alipay.trade.page.pay`, `FAST_INSTANT_TRADE_PAY`), credits are granted only after server-side verification, and each generation consumes one credit.

### Target users
Xiaohongshu creators, small shop owners and micro-merchants who need lots of marketing copy daily without an expensive subscription; students and freelancers who prefer pay-per-use.

### Payment flow
Browse packs → select → server creates the order (amount from the server catalog only, server-generated `out_trade_no`) → redirect to the Alipay cashier → async notify `/api/alipay/notify` (RSA2 signature check plus `app_id`, `seller_id`, `out_trade_no`, `total_amount`, `trade_status` checks, idempotent crediting) → return URL `/payment/return` (return params are never trusted; pending orders are reconciled with `alipay.trade.query`) → receipt `/receipt/:id` → order history `/orders` → spend credits.

### Run
Node.js 22 required.
```bash
npm ci
cp .env.example .env      # optional; PAY_MODE=mock by default
npm start                 # http://127.0.0.1:3000
npm test                  # unit/integration tests
npm run smoke             # headless Chrome E2E smoke test (needs google-chrome; override with CHROME_PATH)
```

### Payment modes (`PAY_MODE`)
- `mock` (default): local, clearly labelled mock cashier; it sends an RSA2-signed notify (ephemeral test key) through the same verification code as real Alipay.
- `sandbox`: `https://openapi-sandbox.dl.alipaydev.com/gateway.do` with your Alipay Open Platform sandbox app.
- `production`: `https://openapi.alipay.com/gateway.do` with your real merchant app (HTTPS required). The contest is judged on real paid orders, so this is what you need for the final entry.

### Switching from sandbox to real merchant credentials
1. Complete real-name verification yourself and enable "AI web app payment" / page pay following the [official Vibe Pay web integration guide](https://aipay.alipay.com/docs/vibe-pay/ai-web-app-payment-qianyi/ai-web-app-payment-integration-guide.md), including merchant signing.
2. Create the app on the Open Platform, set up RSA2 keys, keep the **app private key** on the server only, and note the **Alipay public key**, `APP_ID` and merchant PID (`SELLER_ID`, starts with 2088).
3. Deploy to a public HTTPS domain and set `PAY_MODE=production`, `PUBLIC_BASE_URL`, `COOKIE_SECRET`, `APP_ID`, `APP_PRIVATE_KEY_PATH` (or `APP_PRIVATE_KEY`), `ALIPAY_PUBLIC_KEY`, `SELLER_ID` in `.env`.
4. Verify one sandbox payment first, then one small real order, and confirm the async notify reaches `/api/alipay/notify`.
5. Never commit the private key or `.env`.

### Optional LLM
Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (OpenAI-compatible). Without them, or on failure, a built-in template engine is used; credits are consumed only on success.

### Demo steps
1. `npm start`, open http://127.0.0.1:3000 (banner shows MOCK DEMO, 0 credits).
2. Choose **Standard pack ¥9.90** and buy.
3. Confirm in the cashier (mock cashier, or Alipay sandbox cashier with a sandbox buyer account).
4. The signed notify is verified and you land on the receipt: Paid, order no., Alipay trade no., amount, time.
5. Generate copy in the studio; credits go 20 → 19.
6. See the order under "My orders".

## License
MIT
