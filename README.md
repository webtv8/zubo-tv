# 多地区组播 IP 替换系统（Cloudflare 版）

原 PHP 版本（`index.php` + `api.php` + `classes/`）重构为 **Cloudflare Pages Functions + KV** 版本：

- 部署：GitHub 仓库 → Cloudflare Pages 连接 Git，推代码即自动部署，**只用免费额度**
- 数据：KV 存一份配置 JSON（免费额度：10 万次读/天、1000 次写/天）
- 登录密码：只认 Cloudflare 环境变量 `ADMIN_PASSWORD`，**系统内不再提供修改密码功能**
- 地址更新：`更新组播 IP 端口` 支持 **IP / 域名 / IP:端口 / 域名:端口** 四种写法

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

替换只动协议头之后的主机段：`http://125.33.94.8:4022/rtp/239.3.1.129:8008` → `http://vod.example.com:8080/rtp/239.3.1.129:8008`。
支持 `http / https / rtsp / rtp / udp / hls`，以及没有协议头的裸地址。端口必须是 1–65535 的数字（最多 5 位）。

**哪些频道会被改**（对齐原 `Utils::updateUrlIP` 的保守策略，避免把分组里混着的第三方源改坏）：

- 路径里带 `/rtp/` 的组播代理地址 → 改
- 主机等于该分组当前地址（同一条代理）的地址 → 改，路径不变
- 主机指向别处、路径又不含 `/rtp/` 的外部源（如某 CDN 的备用直播链接）→ **原样保留**，提示里会列出被保留的频道名

---

## 一·五、输出顺序

### 1. 输出永远是全部分组，不做运营商分流

这是按需求做的**简化**：访问 `/txt`、`/m3u` 时不再查访问者 IP、不判断运营商，直接返回全部频道。

- 顺序固定：**组播主分组**按 `whitelist_groups` 的顺序排在前面，**自定义分组**永远排在最后（自定义分组之间按首次出现的顺序）
- 子分组顺序 = 你在文本框里保存的顺序
- 不再有 `?isp=` 参数、没有 `X-ISP` / `X-ISP-Source` 响应头、配置里也没有 `group_isp` / `isp_filter` 字段（旧配置里这两个键会被自动忽略，不用手工清理）
- 想按地区分流多个播放器？维护多份配置没意义，直接给不同播放器用 `/txt` 和 `/m3u` 两个地址即可，或者按分组名各自订阅

### 2. 频道地址原样输出

`/txt`、`/m3u` 里每个频道的地址就是你保存的那个地址，不做任何改写：没有 302 跳转、没有 `/rtp?id=` 拼接、也没有输出设置开关。要换地址就在「更新组播 IP 端口」里改分组地址，保存后播放器重新拉一次列表即可。

---

## 二、部署步骤（Pages + 连接 GitHub，推荐）

**第 1 步：创建 KV 命名空间**

- 左侧菜单 → **存储和数据库** → **KV** → **创建命名空间**（Create namespace）
- 名称填 `mrs-config`，创建后列表里会显示这个命名空间的 **ID**（一串十六进制），先复制留着，下一步绑定用它的名字即可，不用填 ID。

**第 2 步：创建 Pages 项目（继续使用 GitHub 的方式）**

- 左侧菜单 → **Workers 和 Pages** → **创建** → 选 **Pages** 标签 → **连接到 Git** → 点 **继续使用 GitHub**（Continue with GitHub）
- 首次会跳 GitHub 授权页，选 **Only select repositories** → 勾选 `webtv8/zubo-tv` → 授权
- 选仓库 `zubo-tv` → **开始设置**，按下表填：

表格

| 表单项（中文界面） | 填什么 |
| --- | --- |
| 项目名称 | `zubo-tv`（域名就是 zubo-tv.pages.dev，想换名字现在改） |
| 生产分支 | `main` |
| 框架预设 | **无**（None） |
| 构建命令 | **留空** |
| 构建输出目录 | `public` |
| 根目录 | 默认 `/` |

- 点 **保存并部署**。这一步只是把静态页 + `functions/` 编译上去，`ADMIN_PASSWORD` 还没设、KV 也还没绑，登录会失败，属正常。

**第 3 步：绑定 KV 命名空间**

- 进入项目 → **设置** → **绑定**（Bindings）→ **添加** → 类型选 **KV 命名空间**
- 变量名称：`CONFIG_KV`（必须一字不差，代码里按这个名字取）
- KV 命名空间：选第 1 步建的 `mrs-config`
- 环境两个都要加：先加 **生产**，再加一次 **预览**（Preview）

**第 4 步：设置管理员密码**

- 项目 → **设置** → **变量和机密**（Variables and Secrets）→ **添加**
- 名称 `ADMIN_PASSWORD`，值填你的登录密码，类型选 **机密**（Secret，加密存储，控制台不再显示明文）
- 可选再加两条（类型选「文本」即可）：
  - `SESSION_SECRET`：一串随机长字符串，不填就用 `ADMIN_PASSWORD` 派生
  - `SESSION_TTL_HOURS`：`168`（登录有效期 7 天）
- 同样给 **生产** 和 **预览** 两个环境都加。

**第 5 步：重新部署并验收**

- 项目 → **部署**（Deployments）→ 最新一次部署右侧的菜单 → **重新部署**（Retry deployment）。第 3、4 步加的绑定和机密**必须重新部署才生效**。

### 6. 重新部署并访问

改完变量后 **Deployments → Retry deployment**（或再 push 一次），然后打开 Pages 分配的域名：

- 管理后台：`https://xxx.pages.dev/`
- TXT 输出：`https://xxx.pages.dev/txt`
- M3U 输出：`https://xxx.pages.dev/m3u`

---

## 三、本地开发

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

## 四、目录结构

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
