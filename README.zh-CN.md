<p align="center"><code>npm i -g @aiusage/cli</code></p>

<p align="center">
  <strong>AIUsage</strong> 追踪所有 AI 工具在所有设备上的 Token 用量与成本，<br>
  同步到你自己的 Cloudflare Worker，通过公开看板可视化一切。
</p>

<p align="center">
  中文 | <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aiusage/cli"><img src="https://img.shields.io/npm/v/@aiusage/cli?label=npm&color=cb0000&logo=npm" alt="npm" /></a>
  <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
  <a href="https://developers.cloudflare.com/d1"><img src="https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare D1" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="https://aiusage.xdullboy.com"><strong>在线演示</strong></a>
</p>

---

## AIUsage 是什么？

一套自托管、隐私优先的系统，用于追踪你在 AI 编程工具上的真实开销——跨所有设备。

### 支持的工具

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code" />
  <img src="https://img.shields.io/badge/Codex_CLI-6BA539?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0yMi4yODIgOS44MjFhNS45ODUgNS45ODUgMCAwIDAtLjUxNi00LjkxIDYuMDQ2IDYuMDQ2IDAgMCAwLTYuNTEtMi45QTYuMDY1IDYuMDY1IDAgMCAwIDQuOTgxIDQuMThhNS45ODUgNS45ODUgMCAwIDAtMy45OTggMi45IDYuMDQ2IDYuMDQ2IDAgMCAwIC43NDMgNy4wOTcgNS45OCA1Ljk4IDAgMCAwIC41MSA0LjkxMSA2LjA1MSA2LjA1MSAwIDAgMCA2LjUxNSAyLjlBNS45ODUgNS45ODUgMCAwIDAgMTMuMjYgMjRhNi4wNTYgNi4wNTYgMCAwIDAgNS43NzItNC4yMDYgNS45OSA1Ljk5IDAgMCAwIDMuOTk3LTIuOSA2LjA1NiA2LjA1NiAwIDAgMC0uNzQ3LTcuMDczek0xMy4yNiAyMi40M2E0LjQ3NiA0LjQ3NiAwIDAgMS0yLjg3Ni0xLjA0bC4xNDEtLjA4MSA0Ljc3OS0yLjc1OGEuNzk1Ljc5NSAwIDAgMCAuMzkyLS42ODF2LTYuNzM3bDIuMDIgMS4xNjhhLjA3MS4wNzEgMCAwIDEgLjAzOC4wNTJ2NS41ODNhNC41MDQgNC41MDQgMCAwIDEtNC40OTQgNC40OTR6TTMuNiAxOC4zMDRhNC40NyA0LjQ3IDAgMCAxLS41MzUtMy4wMTRsLjE0Mi4wODUgNC43ODMgMi43NTlhLjc3MS43NzEgMCAwIDAgLjc4IDBsNS44NDMtMy4zNjl2Mi4zMzJhLjA4LjA4IDAgMCAxLS4wMzMuMDYyTDkuNzQgMTkuOTVhNC41IDQuNSAwIDAgMS02LjE0LTEuNjQ2ek0yLjM0IDcuODk2YTQuNDg1IDQuNDg1IDAgMCAxIDIuMzY2LTEuOTczVjExLjZhLjc2Ni43NjYgMCAwIDAgLjM4OC42NzZsNS44MTUgMy4zNTUtMi4wMiAxLjE2OGEuMDc2LjA3NiAwIDAgMS0uMDcxIDBsLTQuODMtMi43ODZBNC41MDQgNC41MDQgMCAwIDEgMi4zNCA3Ljg3MnptMTYuNTk3IDMuODU1bC01LjgzMy0zLjM4N0wxNS4xMTkgNy4yYS4wNzYuMDc2IDAgMCAxIC4wNzEgMGw0LjgzIDIuNzkxYTQuNDk0IDQuNDk0IDAgMCAxLS42NzYgOC4xMDV2LTUuNjc4YS43OS43OSAwIDAgMC0uNDA3LS42Njd6bTIuMDEtMy4wMjNsLS4xNDEtLjA4NS00Ljc3NC0yLjc4MmEuNzc2Ljc3NiAwIDAgMC0uNzg1IDBMOS40MDkgOS4yM1Y2Ljg5N2EuMDY2LjA2NiAwIDAgMSAuMDI4LS4wNjFsNC44My0yLjc4N2E0LjUgNC41IDAgMCAxIDYuNjggNC42NnptLTEyLjY0IDQuMTM1bC0yLjAyLTEuMTY0YS4wOC4wOCAwIDAgMS0uMDM4LS4wNTdWNi4wNzVhNC41IDQuNSAwIDAgMSA3LjM3NS0zLjQ1M2wtLjE0Mi4wOEw4LjcwNCA1LjQ2YS43OTUuNzk1IDAgMCAwLS4zOTMuNjgxem0xLjA5Ny0yLjM2NWwyLjYwMi0xLjUgMi42MDcgMS41djIuOTk5bC0yLjU5NyAxLjUtMi42MDctMS41eiIvPjwvc3ZnPgo=&logoColor=white" alt="Codex CLI" />
  <img src="https://img.shields.io/badge/Copilot_CLI-000?style=for-the-badge&logo=githubcopilot&logoColor=white" alt="Copilot CLI" />
  <img src="https://img.shields.io/badge/Gemini_CLI-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white" alt="Gemini CLI" />
  <img src="https://img.shields.io/badge/Amp-FF4F00?style=for-the-badge&logo=sourcegraph&logoColor=white" alt="Amp" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Kimi_Code-4A6CF7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PC9zdmc+&logoColor=white" alt="Kimi Code" />
  <img src="https://img.shields.io/badge/Qwen_Code-5A29E4?style=for-the-badge&logo=alibabacloud&logoColor=white" alt="Qwen Code" />
  <img src="https://img.shields.io/badge/Droid-2C3E50?style=for-the-badge&logo=android&logoColor=white" alt="Droid" />
  <img src="https://img.shields.io/badge/OpenCode-16A34A?style=for-the-badge&logo=go&logoColor=white" alt="OpenCode" />
  <img src="https://img.shields.io/badge/Pi-6C47FF?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjx0ZXh0IHg9IjUiIHk9IjE4IiBmb250LXNpemU9IjE2IiBmb250LWZhbWlseT0ic2VyaWYiPsO/PC90ZXh0Pjwvc3ZnPg==&logoColor=white" alt="Pi" />
</p>

### 为什么选择 AIUsage？

- **本地扫描** — 读取 AI 工具的会话日志，提取 Token 用量，不触及对话内容
- **多设备同步** — 每台机器独立注册，各自持有安全令牌，数据汇聚到你的 Worker
- **成本可视化** — 公开看板展示趋势、模型分布、单次成本等
- **数据自主** — 部署到你自己的 Cloudflare 账户（免费套餐足够），不依赖任何第三方

### 架构

```mermaid
graph LR
  D1["<b>设备 01</b><br/>MacBook Pro"] -- sync --> W["<b>Cloudflare Worker</b><br/>+ D1 数据库"]
  D2["<b>设备 02</b><br/>Mac Mini"] -- sync --> W
  D3["<b>设备 03</b><br/>Linux 服务器"] -- sync --> W
  W -- 公开 API --> Dashboard["<b>看板</b><br/>只读 Web UI"]
```

### 这个 fork

本仓库是 [xiiyioozzz/aiusage](https://github.com/xiiyioozzz/aiusage)，线上看板是 **[aiusage.xdullboy.com](https://aiusage.xdullboy.com)**。

相对上游，这里额外做了：

- Cursor / Kiro / Hermes 按公开牌价估费，Codex 对外显示为 ChatGPT
- 筛选增加 **当天**、**本年**，热力图跟着所选区间变化
- 当天用小时时间线，费用构成按模型拆
- 公开项目名保持可读；Cursor 无项目窗口会映射走，不再堆在 `unknown`

## 部署到 Cloudflare Workers

AIUsage 以单个 Worker + D1 部署。Worker 同时托管公开看板和上报 API。

### 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiiyioozzz/aiusage)

引导流程要求源仓库公开。Build command 使用 `pnpm run build`，Deploy command 使用 `wrangler deploy --config packages/worker/wrangler.jsonc`。远程构建会创建或复用具名 D1、执行 migration 并发布 Worker。完成后设置 Worker 密钥，再用 `aiusage enroll` 接入设备。

### 使用 Wrangler 部署

登录 Wrangler、安装依赖并部署：

```bash
pnpm install
npx wrangler login
pnpm run deploy
```

`predeploy` Hook 会创建或复用具名 D1，对具名数据库应用 migration 并构建看板。账号专属 ID 绝不会写入可移植的 `packages/worker/wrangler.jsonc`。普通 `pnpm run build` 始终是纯本地构建，不访问 Cloudflare。

部署完成后设置 `SITE_ID`、`ENROLL_TOKEN`、`DEVICE_TOKEN_SECRET`、`PROJECT_NAME_SALT`，再用 CLI 注册设备。密钥禁止提交到仓库。详见[部署指南](./docs/deployment-guide.md)。

部署声明以下 binding：

| Binding | Cloudflare 产品 | 用途 |
| --- | --- | --- |
| `DB` | D1 | 设备注册与用量明细的权威数据 |

`pnpm run build` 始终只执行本地 monorepo 构建，不发现或修改远程资源；`pnpm run predeploy` 负责远程资源准备、migration 和看板构建。

## 快速开始

### 让 AI 代理帮你部署

复制以下提示词，粘贴给你的 AI 编程代理（Claude Code、Codex、Copilot、Gemini 等）：

```text
克隆 https://github.com/xiiyioozzz/aiusage.git，阅读 skills/aiusage-server/aiusage-server.md，
帮我把 AIUsage 部署到我的 Cloudflare 账户。
部署完成后，按照 skills/aiusage-cli/aiusage-cli.md 把这台设备接入。
```

### 或手动部署

```bash
git clone https://github.com/xiiyioozzz/aiusage.git
cd aiusage && pnpm install
npx wrangler login
pnpm setup
```

### 本地报告（无需服务端）

```bash
npm i -g @aiusage/cli
aiusage report --range 7d
```

## 保持更新

AIUsage 采用 **Fork 更新模式** — Fork 本仓库，将你的 Fork 连接到 Cloudflare Workers 的 Git 集成，后续更新自动部署。

1. **Fork** 本仓库到你的 GitHub 账户
2. **连接** 你的 Fork 到 Cloudflare Workers（Git 集成）
3. 通过 GitHub 的 "Sync fork" 按钮或 `git merge upstream/main` **同步**上游更新
4. Cloudflare 在每次推送到你的 Fork 时**自动重新部署**

CLI 更新需单独执行：`npm update -g @aiusage/cli`

详见 [**更新指南**](./docs/update-guide.md)，包含通过 GitHub Actions 实现全自动同步的方案。

## 文档

| 文档 | 说明 |
|------|------|
| [**部署指南**](./docs/deployment-guide.md) | 完整部署流程、CLI 参考、API 文档 |
| [**更新指南**](./docs/update-guide.md) | Fork 更新机制与自动部署设置 |
| [**CLI 文档**](./packages/cli/README.zh-CN.md) | CLI 工具详情与全部命令 |


## 许可证

[MIT](LICENSE)
