# 多地区组播 IP 替换系统（Cloudflare 版）


- 部署：GitHub 仓库 → Cloudflare Pages 连接 Git，推代码即自动部署，**只用免费额度**
- 数据：KV 存一份配置 JSON（免费额度：10 万次读/天、1000 次写/天）
- 登录密码：Cloudflare 环境变量 `ADMIN_PASSWORD`，**系统内不提供修改密码功能**

---

## 一、功能对照

| 功能 | 说明 |
| --- | --- |
| 登录 | 密码来自环境变量 `ADMIN_PASSWORD`，会话为 HMAC 签名 Cookie（7 天，可用 `SESSION_TTL_HOURS` 调整） |
| 更新组播 IP 端口 | 选地区 → 填新地址 → 只替换该分组频道的「主机[:端口]」，路径与组播内层地址原样保留；指向第三方主机的非 `/rtp/` 链接会被保留不改（对齐原 `Utils::updateUrlIP`） |
| 组播主分组管理 | 新增 / 编辑 / 删除地区，含子分组与频道文本编辑 |
| 自定义分组管理 | 新增 / 编辑 / 删除，分组名不可与组播主分组重名 |
| 输出链接 | `https://<域名>/txt`、`https://<域名>/m3u`，**免登录**，每次实时读最新配置；**不做 IP 查询、不区分运营商**，永远输出全部频道，组播主分组在前、自定义分组永远在后 |
| ~~修改密码~~ | 已移除：改密码=改 Cloudflare 变量，不需要也不应该在页面里做 |

### 界面上的操作细节（对齐原版 `showTab` / `copyToClipboard` / `confirmClear` / `validateIPFormat`）

- **标签页**：四个标签页切换后记在浏览器 `localStorage`，刷新或下次登录回到你上次停留的那一页
- **复制链接**：输出链接旁的「复制链接」用 `navigator.clipboard`，失败自动回退 `execCommand`，成功后顶部飘提示
- **清空文本框**：新增分组和编辑分组的文本框右上角都有「清空」按钮，弹原生确认框「确定要清空文本框内容吗？此操作不可撤销！」，清空只是清屏，点「保存」才写配置
- **新增分组的默认内容**：对应原版 `config/default_config.php` 里的 `settings.new_group_text_default`，「添加新主分组」的文本框为空时会自动填入这段示例（改成你自己的模板：编辑 KV 里 `config` 的该字段，或直接在文本框里改后添加）
- **窄屏 / 手机**：≤720px 时标签页竖排、分组卡片改为上下排布、输出链接按钮独占一行、长地址自动换行，编辑框高度收窄
- **地址即时校验**：在「新的地址」里输入时下方实时反馈——格式不对当场变红提示（如端口 99999、带路径、带空格），格式正确则显示「✓ 将把「地区」的代理地址改成 `xxx`」

### 新地址支持的四种写法

```
192.168.1.1                 → 192.168.1.1（不带端口，频道原有端口会被去掉）
vod.example.com             → vod.example.com（不带端口）
192.168.1.1:4022            → 替换成新 IP + 新端口
vod.example.com:8080        → 替换成新域名 + 新端口
http://vod.example.com:8080/ → 粘贴完整 URL 也能识别（自动去掉协议头和末尾斜杠）
```

替换只动协议头之后的主机段：
支持 `http / https / rtsp / rtp / udp / hls`，以及没有协议头的裸地址。端口必须是 1–65535 的数字（最多 5 位）。

- 路径里带 `/rtp/` 的组播代理地址 → 改
- 主机等于该分组当前地址（同一条代理）的地址 → 改，路径不变
- 主机指向别处、路径又不含 `/rtp/` 的外部源（如某 CDN 的备用直播链接）→ **原样保留**，提示里会列出被保留的频道名

---

## 一·五、输出顺序


- 顺序固定：**组播主分组**按 `whitelist_groups` 的顺序排在前面，**自定义分组**永远排在最后（自定义分组之间按首次出现的顺序）
- 子分组顺序 = 你在文本框里保存的顺序

- 想按地区分流多个播放器？维护多份配置没意义，直接给不同播放器用 `/txt` 和 `/m3u` 两个地址即可，或者按分组名各自订阅

### 2. 频道地址原样输出

`/txt`、`/m3u` 里每个频道的地址就是你保存的那个地址，不做任何改写。要换地址就在「更新组播 IP 端口」里改分组地址，保存后播放器重新拉一次列表即可。

---

## 二、部署步骤（Pages + 连接 GitHub，推荐）

### 1. Cloudflare 建 KV 命名空间

控制台 → **Storage & Databases → KV** → **Create namespace**，名称随意（如 `mrs-config`）。

### 2. Pages 连接仓库

控制台 → **Workers & Pages → Create → Pages → Connect to Git** → 选刚推的仓库，构建配置填：

| 项 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | 留空 |
| Build output directory | `public` |
| Root directory | `/`（默认） |

> 不需要 npm install / 构建步骤：`public/` 是静态页面，`functions/` 由 Pages 自动编译。

### 3. 绑定 KV

项目 → **Settings → Bindings（或 Functions → KV namespace bindings）** → Add：

- Variable name：`CONFIG_KV`（**必须一字不差**）
- KV namespace：选第 2 步创建的那个
- 生产环境与 Preview 环境都加上

### 4. 设置管理员密码

项目 → **Settings → Variables and Secrets** → Add：

- Name：`ADMIN_PASSWORD`
- Value：你的登录密码
- Type：**Secret**（加密存储）

可选再加：

- `SESSION_SECRET`：会话签名密钥（建议随机长字符串；不填则用 `ADMIN_PASSWORD` 派生）
- `SESSION_TTL_HOURS`：登录有效期，默认 `168`（7 天）

### 6. 重新部署并访问

改完变量后 **Deployments → Retry deployment**（或再 push 一次），然后打开 Pages 分配的域名：

- 管理后台：`https://xxx.pages.dev/`
- TXT 输出：`https://xxx.pages.dev/txt`
- M3U 输出：`https://xxx.pages.dev/m3u`

---

## 三、Workers 方式部署（可选）

同一个仓库也能用 Workers 部署，逻辑完全共用：

```bash
npm install
npx wrangler kv namespace create CONFIG_KV     # 把返回的 id 填进 wrangler.toml
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

`wrangler.toml` 里 `main = "src/worker.js"`，`[assets] directory = "./public"`，`[[kv_namespaces]] binding = "CONFIG_KV"`。

> 注意：Pages 走 Git 自动部署时**不读** `wrangler.toml`，变量和 KV 都在控制台配；Workers 部署才用 `wrangler.toml`。

---

## 四、本地开发

```bash
npm install
cp .dev.vars.example .dev.vars     # 填 ADMIN_PASSWORD
npm run dev                        # wrangler pages dev public，本地 KV 模拟
```

打开终端提示的地址（一般是 http://localhost:8787）。

不需要 wrangler 也能验证业务逻辑：

```bash
npm test
```

`test/run.mjs` 用内存 KV 直接跑 API，共 **67 项断言**：登录/鉴权、四种地址写法与替换结果、非法输入、txt/m3u 输出顺序、分组增删改、伪造 Cookie、CSRF 来源校验、已移除的改密码接口，输出永远是全部分组且自定义分组排在最后、地址按保存内容原样输出（无 302 改写）、`?isp` 不再影响输出、没有任何运营商响应头、地址更新只作用于本分组代理地址（外部链接保留、只在填 IP 时去掉端口、端口越界拒绝）。

---

## 五、目录结构

```
cf-multicast-admin/
├── functions/                 # Pages Functions（自动路由）
│   ├── api/[[path]].js        # /api/* 路由入口
│   ├── txt.js                 # GET /txt（公开）
│   ├── m3u.js                 # GET /m3u（公开）
│   └── _lib/
│       ├── api.js             # 登录、状态、地址更新、分组增删改
│       ├── auth.js            # 密码校验 + 签名 Cookie 会话
│       ├── channels.js        # 地址校验、URL 主机替换、文本解析
│       ├── output.js          # txt / m3u 生成（主分组在前，地址原样输出）
│       └── store.js           # KV 读写 + 配置归一化
├── public/                    # 静态页面（Pages 的构建输出目录）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/worker.js              # Workers 部署入口（可选）
├── test/run.mjs               # 逻辑自测
├── wrangler.toml
└── package.json
```

### 数据格式（KV key：`config`）

```json
{
  "settings": {
    "whitelist_groups": ["A市", "B市"],
    "region_ips": { "A市": "vod.example.com:8080" },
    "new_group_text_default": "卫视频道,#genre#\nCCTV1,http://192.168.0.1:4022/rtp/239.3.1.129:8008"
  },
  "groups": [{ "name": "A市", "enabled": true }],
  "channels": [
    { "name": "CCTV1", "url": "http://vod.example.com:8080/rtp/239.3.1.129:8008", "group": "A市", "genre": "卫视频道", "enabled": true }
  ]
}
```

配置接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 是否已登录、密码是否已配置 |
| POST | `/api/login` | `{password}` |
| POST | `/api/logout` | 退出 |
| GET | `/api/state` | 配置 + 统计 + 输出地址（需登录） |
| POST | `/api/target` | `{region, target}` 更新某地区地址 |
| POST | `/api/group/add` | `{type:"whitelist"\|"custom", name, target?, text}` |
| POST | `/api/group/update` | `{type, name, text, target?}` |
| POST | `/api/group/delete` | `{type, name}` |
| GET | `/api/output?jk=txt\|m3u` | 公开输出（等同 `/txt`、`/m3u`） |

---

## 六、注意事项

- **单用户量级**：KV 是最终一致存储，多人同时编辑时后写会覆盖先写。单人管理够用。
- **写次数**：KV 免费额度 1000 次写/天，日常编辑远远用不到；如果批量导入大量分组，一次保存算一次写。
- **输出缓存**：`/txt`、`/m3u` 返回 `Cache-Control: no-store`，播放器每次拉取都是最新内容。
- **安全**：密码只存在于环境变量与请求内存中；会话 Cookie 为 `HttpOnly + SameSite=Lax + Secure`；所有写接口校验 `Content-Type: application/json` 与 `Origin`。
- **未绑定 KV 时**：页面会红色提示，所有保存操作都会失败——先绑 `CONFIG_KV` 再使用。

