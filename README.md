# 导航站（Cloudflare Pages 版）

基于 [eooce/nav-item](https://github.com/eooce/nav-item) 的 Cloudflare Pages 移植版。原项目是 Node.js + Express + SQLite，本项目把后端重写成 Worker，数据存放在 D1，上传的图片存放在 KV，**不需要自己的服务器**，连接 GitHub 即可自动部署。

## 功能

- 分类 / 子分类 / 卡片管理，支持分类加密（访问密码）
- 广告位、友情链接
- 书签导入导出（JSON，以及浏览器导出的 HTML 书签）
- 后台更换壁纸：上传图片，或填写图片 URL，支持恢复默认
- 管理员登录、修改密码、显示上次登录时间和 IP

## 工作方式

| 部分     | 实现                                             |
|--------|------------------------------------------------|
| 前端     | `public/` 里编译好的静态文件，由 Pages 托管，未知路径回退到 `index.html` |
| 后端 API | `functions/[[path]].js` 调用 `src/index.js`（Hono）；`public/_routes.json` 让 Functions 只处理 `/api/*` 和 `/uploads/*` |
| 数据库    | Cloudflare D1，首次访问时自动建表                        |
| 图片存储   | Cloudflare KV（单张最大 10MB）                       |
| 登录     | JWT，有效期 2 小时；密码使用 PBKDF2 哈希                    |

## 部署

### 1. 创建 D1 和 KV（Pages 不会自动创建）

Cloudflare 后台：**Storage & Databases → D1 → Create database**（如 `cl-nav-db`），再到 **KV → Create namespace**（如 `cl-nav-kv`）。

### 2. 连接仓库

1. **Workers & Pages → Create → Pages → Connect to Git**，选择该仓库，分支 `main`。
2. 构建设置：
   - Framework preset：`None`
   - Build command：`npm install`
   - Build output directory：`public`
3. 保存并部署（第一次部署后还没绑定资源，API 会报错，属正常）。

### 3. 绑定资源和环境变量

Pages 项目 → **Settings**：

- **Bindings** 添加：D1 database，变量名 `DB`；KV namespace，变量名 `KV`（Production 和 Preview 都加）
- **Variables and Secrets** 添加：

| 名称               | 类型     | 说明                               |
|------------------|--------|----------------------------------|
| `ADMIN_USERNAME` | 文本     | 管理员用户名，不填默认 `admin`              |
| `ADMIN_PASSWORD` | Secret | 管理员密码，**必填**                     |
| `JWT_SECRET`     | Secret | 登录令牌密钥，建议填随机字符串；不填会自动生成并保存在数据库里 |

绑定和变量修改后，需要 **Deployments → Retry deployment**（或重新推送一次）才会生效。

### 4. 检查并登录

访问 `https://<项目名>.pages.dev/api/health`，确认 `kvBound`、`adminPasswordSet` 为 `true`，然后打开 `/admin` 登录。

## 迁移原数据

在原站后台导出书签（JSON 或 HTML），再到新站后台导入。导入采用合并方式：同名分类会合并，同一分类下相同网址会跳过。

## 本地开发

```
npm install
echo 'ADMIN_PASSWORD=你的密码' > .dev.vars
npm run dev
```

使用本地模拟的 D1 和 KV，数据保存在 `.wrangler/` 目录里，已被 `.gitignore` 排除。

## 常见问题


**忘记管理员密码**
在 D1 控制台执行 `DELETE FROM users;`，然后用环境变量里的账号密码重新登录，管理员会被重新创建。

**登录时报 1102 或 Exceeded CPU**
Pages Functions（与 Workers 同样限制）免费版每次请求的 CPU 时间很短，密码哈希可能超时。可以升级到 Workers 付费版，或降低 `src/index.js` 里 PBKDF2 的迭代次数（默认 100000）。

**上传图片失败**
单张图片限 10MB，只支持 jpg / png / webp / gif / avif / ico。大图可以改用图片 URL。

**workers.dev 域名访问不稳定**
在 Pages 项目的 **Custom domains** 里绑定自己的域名。

## 目录结构

```
.
├── public/          前端编译文件（含 _routes.json）
├── src/index.js     Worker 后端
├── functions/       Pages Functions 入口
└── package.json
```

## 安全说明

- 仓库里不包含任何密钥，管理员密码和 JWT 密钥只存在于 Cloudflare 的环境变量里。
- 上传接口和壁纸设置接口都需要登录。
- 登录接口目前没有限流，建议在 Cloudflare 里为 `/api/login` 配置速率限制规则，或开启 Turnstile 等防护。

## 许可

前端和接口设计来自 [eooce/nav-item](https://github.com/eooce/nav-item)（MIT License），请同时遵守原项目的许可条款。
