# theychat 设计文档

> 一个面向多 Agent 协作的最小化消息通信平台：HTTP API（POST/GET）+ CLI + 不丢消息的订阅保证。
> **没有任何认证**：任何能碰到端口的人都能读写一切频道——只该部署在可信网络。

> theychat 是 Anotify 的「去认证」简化版：彻底删除注册、登录、账号、频道密码锁，
> 只保留频道消息核心（append-only 日志 + 服务端游标 / ACK 不丢消息保证）。
> §4 可靠投递、§5 游标初始化、§12 文件交换与 Anotify 完全一致。

## 1. 目标与非目标

### 目标（v1）

1. **极简核心**：以「频道（channel）」为单位，`POST` 发布消息、`GET` 拉取消息，纯 HTTP，无 WebSocket 依赖。
2. **CLI 工具**：`theychat` 命令行，覆盖收、发、ACK、查游标等全部日常操作。
3. **零门槛身份**：客户端本地生成一个 `client_id`，每个请求带在头上即可；没有任何服务端建档。
4. **不丢消息（核心保证）**：client 在处理一条消息期间到达的新消息，**在结构上保证**不会漏掉；client 崩溃重启后未处理的消息**自动重新可见**。

### 非目标（v1 明确不做）

- **任何形式的认证 / 权限 / ACL**（所有频道公开读写；这是设计立场，不是疏漏）
- 命名订阅（一个 client_id 对一个频道只有一条游标）
- 消息过期/TTL、存储配额（文件有兜底 TTL，见 §12）
- 推送（WebSocket/SSE）、跨服务器分布式部署
- 端到端加密
- 名册 / 好友 / 私信等一切社交图谱

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **Channel** | 消息频道，名字唯一（`[a-zA-Z0-9_-]{1,64}`），需显式创建；一律公开 |
| **Message** | 追加到频道日志的一条记录，携带频道内单调递增的 `seq` |
| **client_id** | 客户端本地生成一次的透明标签（`[A-Za-z0-9._-]{1,64}`），服务端不建档、不验证、不存哈希 |
| **from** | 发送者显示名，发消息 / 文件时自报的普通字符串（1–64 字符，缺省 `anon`）；不唯一、不可信、无名册校验 |
| **Cursor** | 服务端为每对 `(channel, client_id)` 维护的消费游标（水位线） |
| **成员** | 在该频道**有游标**（`cursors` 表有行）的 client_id。仅用于圈定文件收件人快照（§12），没有任何访问控制含义 |

### 消息日志模型

每个频道是一条 **append-only 日志**。消息一旦写入不可修改、不可删除（v1 无过期策略）。

```
channel "general" 的日志：
seq:    1     2     3     4     5     ...
        M1    M2    M3    M4    M5
```

`seq` 由服务端在写入时分配，频道内严格单调递增、无空洞。**日志只增不减，这是所有可靠性保证的物理基础。**

---

## 3. 身份退化：client_id + 自报 from

Anotify 有完整身份体系（注册、凭证、名册、频道门禁）。theychat 把它整体退化成两个普通字符串：

### client_id —— 游标归属标签

- 客户端本地生成一次（建议 32 位随机 hex），此后**每个需要游标的请求**以 `X-Client-Id` 头发送
- 服务端**不建档、不验证、不存哈希**——它只是游标归属的透明标签；换一个 id 就是一个新身份，丢一个 id 游标就丢（无恢复机制，也没有需要恢复的凭证）
- 格式校验：1–64 字符，`[A-Za-z0-9._-]`
- 游标键 = `(channel, client_id)`；首次拉取自动初始化游标（§5 的 10 分钟策略原样保留）
- 需要 `X-Client-Id` 的端点：`GET messages`、`POST ack`、`GET cursor`、`POST files`、`POST files/:id/received`。缺头 → `400 missing_client_id`；格式非法 → `400 invalid_client_id`
- `GET /v1/channels`：头可选。带头多返回 `my_cursor` / `pending`；不带头只有公共字段

### from —— 发送者显示名

- 发消息 / 文件时自报的普通字符串参数（1–64 字符，trim；缺省 `"anon"`），存进 `messages.sender`，读接口照原样返回
- **不唯一、不可信、无名册校验**：两个人都可以叫 alice；伪造别人的名字在协议上不设防（也没法设防——这就是无认证世界的形状）
- 频道 `created_by` 记录创建时自报的 from（可空），纯展示

### 频道成员的新定义

- 在该频道**有游标**（`cursors` 表有行）的 client_id，即「成员」
- 唯一用途：上传文件时圈定**收件人快照**（`file_recipients`，存 client_id），驱动「接收即删除」（§12）；上传者自己（同 client_id）确认不计数
- 没有 join、没有名册查询、没有访问控制——拉取即入册，仅此而已

### 为什么可以这么做

theychat 的定位是**可信网络内**的 agent 协作工具（本机、内网、自有 VPS + 防火墙）。
在这个前提下游标不需要防盗、名字不需要防伪、频道不需要门禁——
把这些连同账号体系一起删掉，换来自部署零配置与客户端零注册。
**把端口暴露到不可信网络等于把整个数据库公开。**

---

## 4. 可靠投递机制（本文档核心）

### 4.1 要解决的问题

Client 的典型工作循环：

```
A: 拉到 M1 ──→ 处理 M1（秒级~分钟级）──→ 回复
                  ↑
            这段时间里 M2、M3 到达了频道
```

如果消息传递是「一次性移交」（读即删，或拉取时用会越过新消息的时间戳快照），M2/M3 就会在 A 的处理窗口里丢失。

### 4.2 三条结构原则

**原则一：日志只增不减**（见 §2）

新消息永远只是追加，任何人的读取行为都不影响日志。

**原则二：取走（fetch）≠ 消费（consume）**

`GET` 是纯读，服务端不做任何标记。消息从「client 视角」看有三个状态：

```
stored     seq=N 已写入日志，所有 cursor < N 的 client 可见
   │
fetched    GET 已把它返回给某 client（服务端零标记）
   │
acked      该 client 显式 ACK，其 cursor 推进到 ≥ N
           从此默认拉取不再返回（但可用 since 显式回放）
```

**原则三：游标是水位线（watermark），只在 ACK 时推进**

```
POST /channels/{ch}/ack   body: {"through": 5}
语义：「seq ≤ 5 的消息我已全部处理完毕」
```

- 游标只进不退：`new_cursor = max(old_cursor, through)`
- `through` 会被钳制到 `min(through, 当前频道 latest_seq)`，防止误 ACK 到尚未存在的 seq 导致静默跳过未来消息
- v1 不做逐条 ACK + 空洞管理：client 工作循环是顺序处理的，水位线语义简单且足够

### 4.3 完整时序验证（对照 §4.1 的场景）

```
seq:    1     2        3
日志:   M1    M2       M3
              ↑        ↑
A: GET（cursor=0）→ 返回 M1          （fetch，服务端零标记）
A: 处理 M1 ………… M2、M3 到达，追加进日志（A 的游标纹丝不动）
A: 处理完 M1 → POST ack {through:1}   （cursor: 0 → 1）
A: GET（不传 since → 用服务端 cursor=1）
   → 返回 M2、M3  ✔ 一条不漏
```

### 4.4 崩溃恢复（at-least-once）

```
A: GET → M1,M2,M3
A: 处理完 M1 → ack {through:1}        （cursor=1）
A: 开始处理 M2 → 💥 崩溃（M2/M3 未 ACK）
A: 重启 → GET（cursor 仍是 1，存在服务端）
   → 返回 M2,M3  ✔ 未处理的消息自动重新可见，已处理的 M1 不重复
```

投递语义为 **at-least-once**：极端情况下（ACK 发出但处理副作用未落盘）消息可能重复消费，因此 **client 的处理逻辑必须幂等**（以 `(channel, seq)` 作为去重键即可）。Client 可以在每处理完一条就 ACK 一次，把重复窗口压到最小。

### 4.5 显式回放（since 覆盖）

```
GET /channels/{ch}/messages             → 从服务端 cursor 开始（默认行为）
GET /channels/{ch}/messages?since=0     → 从头回放全部历史，不影响游标
GET /channels/{ch}/messages?since=42    → 从 seq=43 开始，不影响游标
```

**读永远不会污染游标状态，只有 ACK 会。** 这让调试、新 client 补历史、事故排查都不需要特殊机制。

### 4.6 因果引用（reply_to）

发布接口返回服务端分配的 `seq`；消息体可选携带 `reply_to`（同频道内另一条消息的 seq）。

这解决时序错乱的另一半问题：A 处理 M1 期间 M2 到达，A 的回复可能落在 M2 **之后**——**漏不会发生（游标保证），乱序可追溯（reply_to 保证）**。消费方按 `reply_to` 重建线程，而不是依赖到达顺序。

---

## 5. 游标初始化策略

新 client 第一次拉取某频道（服务端无该 `(channel, client_id)` 游标）时：

```
初始 cursor = 该频道中「早于 now - 600 秒」的最后一条消息的 seq
            = COALESCE(MAX(seq) WHERE created_at < now-600s, 0)
```

效果：

- **最近 10 分钟内的消息全部可见**（不丢近期上下文）
- 10 分钟前且未 ACK 过的历史不推送，但**永远可以显式回放**（`?since=0`）
- 若频道近 10 分钟无消息，cursor 落在最新位置，只收之后的新消息

首次拉取的响应携带 `cursor_initialized: true` 标记，CLI 据此打印提示：

```
提示：当前从最近 10 分钟内的消息开始。
如需补看全部历史：theychat recv <channel> --from-start
```

游标一旦初始化即持久化，之后是否拉取、何时 ACK 都不影响这个初始位置（这一刻也把该 client_id 记为频道成员——文件收件人快照的依据，见 §12）。

---

## 6. API 规格

统一约定：

- Base path：`/v1`（预留版本化）
- **认证：没有。** 除 `X-Client-Id` 头（仅游标类端点要求、格式校验）外没有任何凭证
- 错误格式：`{"error": {"code": "...", "message": "..."}}`
- 常见错误码：400 缺 / 非法 `X-Client-Id` · 404 频道不存在 · 409 重名 · 413 消息 / 文件过大 · 422 参数错误
- 不存在 401/403

### 6.1 `POST /v1/channels` — 创建频道

```json
请求:  {"name": "general", "from": "alice"}     // from 可选
响应 201: {"name": "general", "created_at": 1767400000.123, "created_by": "alice"}
冲突 409: 频道已存在
```

`created_by` 记录创建时自报的 from，纯展示、可空。频道一律公开，没有密码锁。

### 6.2 `POST /v1/channels/{ch}/messages` — 发布消息

```json
请求:  {
         "content": "hello",
         "content_type": "text/plain",     // 可选，默认 text/plain；支持 application/json
         "reply_to": 41,                   // 可选，同频道内另一条消息的 seq
         "from": "alice"                   // 可选，自报显示名；缺省 "anon"
       }
响应 201: {"channel": "general", "seq": 42, "sender": "alice",
           "content": "hello", "reply_to": 41, "created_at": 1767400010.5}
```

- `sender` 就是自报的 `from`，服务端不做任何归属校验
- `reply_to` 必须指向该频道已存在的 seq，否则 422
- 单条消息上限 64 KB（413）
- 频道不存在返回 404（**不隐式创建**，防止 typo 产生幽灵频道）
- 发布不需要 `X-Client-Id`（发送侧没有游标状态）

### 6.3 `GET /v1/channels/{ch}/messages` — 拉取消息（长轮询）

| 参数 | 默认 | 说明 |
|---|---|---|
| `since` | 服务端游标 | 起始位置（返回 seq > since 的消息）；显式传入时**仅本次生效**，不动游标 |
| `wait` | 0 | 长轮询秒数（0–60）；频道内暂无新消息时挂起等待 |
| `limit` | 100 | 单次最多返回条数 |

```json
响应 200: {
  "channel": "general",
  "messages": [
    {"seq": 42, "sender": "alice", "content": "hello",
     "content_type": "text/plain", "reply_to": 41, "created_at": 1767400010.5}
  ],
  "cursor": 41,                // 本次拉取使用的游标值
  "cursor_initialized": false, // true = 本次请求刚完成游标初始化（见 §5）
  "latest_seq": 42
}
```

- 无新消息且 `wait=0` → 返回空数组（200）
- 长轮询超时仍无新消息 → 返回空数组（200），客户端继续下一轮即可
- `X-Client-Id` 决定游标归属：同一个频道，不同 client_id 各自独立游标、互不可见

### 6.4 `POST /v1/channels/{ch}/ack` — 推进游标

```json
请求:  {"through": 42}
响应 200: {"channel": "general", "cursor": 42}
```

- 只进不退；`through < 当前游标` 时为幂等 no-op，返回当前游标
- `through` 钳制到 `min(through, latest_seq)`

### 6.5 `GET /v1/channels/{ch}/cursor` — 查看游标

```json
响应 200: {"channel": "general", "client_id": "0ab1c2…", "cursor": 42, "updated_at": ...}
```

### 6.6 `GET /v1/channels` — 列出频道

```json
响应 200: {"channels": [
  {"name": "general", "latest_seq": 42, "created_at": ..., "created_by": "alice"}
]}
```

带头 `X-Client-Id` 时每项多返回自己的视角：

```json
  {"name": "general", "latest_seq": 42, "my_cursor": 42, "pending": 0, ...}
```

`pending = latest_seq - my_cursor`：当前积压待处理消息数，CLI 和 agent 可用它决定是否需要拉取。

### 6.7 `GET /v1/info` — 实例信息

```json
响应 200: {"instance_id": "srv_…", "max_file_bytes": 26214400, "file_ttl_seconds": 86400}
```

`instance_id` 首次启动生成并持久化，客户端据此识别「多个 URL 指向同一服务端」。

### 6.8 `GET /healthz`

`{"ok": true}`。

### 6.9 `GET /v1/channels/{ch}/members` — 频道成员列表

```json
响应 200: {"channel": "general", "count": 2, "members": [
  {"client_id": "0ab1c2…", "cursor": 42, "updated_at": ...},
  {"client_id": "6e1b98d4…", "cursor": 7, "updated_at": ...}
]}
```

成员 = 在该频道持有游标（`cursors` 有行）的 client_id（§3 既有定义），按 `updated_at` 降序——最近活跃在前。只读公开信息：无需 `X-Client-Id`，服务端不为此建档；适合给 `@` 提及挑选 id 前缀。

---

## 7. CLI 规格（theychat）

### 配置与身份

- profile 文件：`~/.config/theychat/profiles/<name>.toml`（0600）

```toml
server = "http://localhost:8000"
client_id = "9f2c…（本地生成一次，长期复用）"
name = "alice"          # 显示名，发送时可被 --from 覆盖
```

- `theychat profile add <name> --server URL [--display-name N]`：本地生成 client_id，**不访问服务端**
- 环境变量覆盖：`THEYCHAT_SERVER` + `THEYCHAT_CLIENT_ID`；profile 选择用 `--profile` 或 `THEYCHAT_PROFILE`。无默认 profile

### 命令一览

```bash
theychat profile add <name> --server URL [--display-name N]   # 建立本地 profile（纯本地）
theychat profile list / theychat profile remove <name>

theychat channels [-o json]               # 列出频道（带头附 pending 积压）
theychat channel create <name>

theychat send <channel> [text] [--reply-to SEQ] [--json]   # 发布（--json 从 stdin 读 JSON）
theychat send <channel> --file PATH [caption] [--reply-to SEQ]   # 发文件（默认上限 25 MiB）
theychat download <channel> <seq> [-o PATH|-] [-f]         # 按消息 seq 下载，校验 sha256
theychat recv <channel> [--wait 30] [--limit 100]
              [--no-ack]                 # 程序化模式：只读不 ACK
              [--since N] [--from-start] # 显式回放
theychat ack <channel> --through N        # 手动推进游标
theychat cursor <channel>                 # 查看游标

theychat serve [--database-url URL] [--host H] [--port P]   # 一条命令起服务
theychat tui                              # 只读人类视图
```

### 关键行为约定

- **`recv` 默认拉取后自动 ACK**（`--through 本批最大 seq`）：面向人类交互场景，看一眼即消费。
- **`--no-ack` 面向 agent 程序化使用**：只读，由 agent 代码在「处理完成」后显式调用 `theychat ack`。
- `recv --from-start` 等价于 `?since=0`，并提示该操作不影响游标。
- 首次拉取（游标初始化）时打印 §5 的补历史提示。
- 所有需要身份的请求带 profile 里的 `X-Client-Id`；发送默认带 profile 的 name 作为 `from`。

---

## 8. 存储设计（Postgres + 文件 blob）

元数据存 **Postgres**（由 `docker-compose.yml` 一起编排）。文件 blob 默认存本地 `/data/files`——文件接收即删除、最多保留 24 小时（§12），本地磁盘足够；配置 `THEYCHAT_S3_*` 即切换到 S3 兼容对象存储。

### 表结构与版本化迁移

`src/db.js` 的 `MIGRATIONS` 数组即全部表结构，启动时按序执行未执行过的版本（记录在 `schema_migrations`，咨询锁保证多实例并发启动安全）。**只追加、不修改**——改表就加一个新版本。

| 版本 | 内容 |
|---|---|
| v1 | `meta`、`channels`（含 `last_seq`、`created_by`）、`messages`、`files`（`client_id` + `"from"`、`deleted_at/deleted_reason`）、`file_recipients`、`cursors` —— 就这一版，没有账号 / 名册 / 会话表 |

时间戳是 `DOUBLE PRECISION` 秒。

### seq 分配

`UPDATE channels SET last_seq = last_seq + 1 WHERE name = $1 RETURNING last_seq` 与消息 `INSERT` 同一事务：该 UPDATE 对频道行加行锁直到提交，同频道并发写入被串行化，`seq` 严格单调、无空洞；不同频道互不阻塞。`latest_seq` 直接读 `channels.last_seq`（只看得到已提交值，与可见消息一致）。

### 长轮询实现

写入提交后在进程内 `EventEmitter` 上发 `message` 事件，等待中的 `GET /messages` 立即被唤醒重查；另以 2 秒间隔兜底重查（多实例部署时别的进程写入的消息靠它发现）。

---

## 9. 技术选型与项目结构

选 Node.js 技术栈，仓库采用 **npm workspaces monorepo** 形态。

| 组件 | 选择 |
|---|---|
| 仓库形态 | npm workspaces monorepo（根 `package.json` 定义 workspaces） |
| 运行时 | Node.js ≥ 18（原生 `fetch`，CLI 无需 HTTP 依赖；开发/部署推荐 20+ LTS） |
| 服务端 | Hono + @hono/node-server（纯 JS、零原生依赖、Node 18/20+ 全兼容） |
| 存储 | Postgres（node-postgres）；文件 blob 本地目录或 S3 兼容存储（minio 客户端） |
| CLI | commander（轻量、零构建） |
| Web 前台 | React 18 + Vite（移植自 Anotify landingpage、去认证；构建产物 `dist/` 由服务端同端口静态托管于 `/`，身份同样是 localStorage client_id + 自报 from） |
| 语言 | 纯 ESM JavaScript（无编译步骤）；后续可平滑迁移 TypeScript（Web 前台除外，其为 JSX 需构建） |

```
theychat/                       # npm workspaces monorepo
├── DESIGN.md                   # 本文档
├── README.md
├── package.json                # workspaces 定义 + 顶层脚本
├── docker-compose.yml          # theychat + postgres
├── Dockerfile
├── skill/SKILL.md              # 给 agent 看的使用说明
├── theychat-backend/           # 服务端（npm 包 theychat-backend，private）
│   ├── package.json
│   ├── src/
│   │   ├── server.js           # Hono 路由与启动（X-Client-Id 中间件；末尾静态托管 theychat-web/dist）
│   │   ├── db.js               # Postgres 访问层（事务、seq 分配、游标）
│   │   ├── files.js            # 文件 blob 存储（流式落盘、sha256、孤儿回收，§12）
│   │   └── schemas.js          # 请求/响应校验（client_id、from、消息、文件名）
│   └── test/                   # e2e：起真实服务端 + 一次性数据库
├── theychat-cli/               # CLI（npm 包 theychat）
│   └── src/                    # main.js / config.js / render.js / tui.js / api.js / …
└── theychat-web/               # Web 前台（React + Vite，移植自 Anotify landingpage 并去认证）
    ├── src/                    # pages/(Landing, Console) + components/ + identity.js（替代原 session）
    └── dist/                   # vite build 产物；服务端托管于 /（改源码后需重新 build）
```

---

## 10. 可靠性保证总结

| 保证 | 由什么实现 |
|---|---|
| 处理期间到达的消息不漏 | 日志 append-only + 服务端游标只在 ACK 时推进（§4.2、§4.3） |
| 崩溃后未处理消息自动恢复 | 游标存服务端，fetch 不推进游标（§4.4） |
| 历史可回溯 | 日志永不删除 + `since` 显式回放不动游标（§4.5） |
| 时序错乱可追溯 | 发布返回 seq + `reply_to` 因果引用（§4.6） |
| 多 client 互不干扰 | 游标按 `(channel, client_id)` 隔离 |
| 不静默跳过未来消息 | ACK 钳制到 `latest_seq`（§4.2 原则三） |

**给 agent 开发者的契约**：投递语义为 at-least-once，处理逻辑须以 `(channel, seq)` 为键做幂等；推荐的消费循环为「GET → 逐条处理 → 每条处理完即 ACK → 循环」。

---

## 11. 未来扩展方向（v2 候选，v1 不实现）

- 命名订阅：`(client_id, channel, subscription)` 三元组多游标
- 消息 TTL 与存储配额
- WebSocket/SSE 推送模式（游标语义不变，仅传输层替换）
- pending 消息超时提醒（client 长时间未 ACK 时告警）
- 多频道统一收件箱视图（按时间合并多个频道的 pending）
- 可选的共享秘密频道锁（若部署环境不再完全可信时再考虑）

---

## 12. 文件交换

场景：agent 之间直接传递中等大小的结果文件（如一份结果 CSV），而不是把内容塞进 64 KB 的文本消息。

### 核心原则：文件即消息

上传一个文件 = 往频道日志追加一条**文件消息**。它照常拥有 `seq`、走游标 / ACK / `reply_to` / at-least-once，**不存在第二条投递通道**——§4 的全部可靠性保证对文件自动成立。

- 文件消息 `content_type = application/vnd.theychat.file+json`（theychat 自有取值，与 CLI 端 FILE_CONTENT_TYPE 常量一致），`content` 为元数据 JSON：
  `{"file_id","name","size","sha256","mime","caption","from"}`
- 该 content_type **只能由 `POST /files` 产生**；`POST /messages` 拒收（422），文件引用无法伪造
- 老版本客户端收到文件消息只会原样打印元数据 JSON，不会出错

### API

**`POST /v1/channels/{ch}/files?name=<文件名>[&caption=<附言>][&reply_to=<seq>][&from=<显示名>]`**

- body 为**原始字节流**（`application/octet-stream`，不走 JSON/base64）
- 服务端流式写入临时文件，边写边算 sha256 与字节数，超限立即中止
- 成功 → `201`，返回体同发布消息，额外带 `file` 元数据对象

| 错误 | 含义 |
|---|---|
| `413 file_too_large` | 超过单文件上限（先查 Content-Length，分块上传则在流上截断） |
| `422 empty_file` / `invalid_param` | 空文件 / 文件名非法（须为单段文件名，≤255 字节，无路径分隔符与控制字符）/ 附言超 4 KB |
| `507 storage_quota_exceeded` | 服务端文件总量配额已满 |

**`GET /v1/channels/{ch}/files/{file_id}`**

- 流式下载；`file_id` 必须属于该频道（跨频道引用 404）
- 响应头：`Content-Type`（按扩展名推断）、`Content-Length`、`Content-Disposition: attachment`、`X-theychat-Sha256`
- blob 在磁盘上丢失 → `410 file_gone`

### 存储

```sql
CREATE TABLE files (
    id         TEXT PRIMARY KEY,          -- f_ + 随机串，即 blob 文件名
    channel    TEXT NOT NULL,
    seq        INTEGER NOT NULL,          -- 对应的文件消息
    client_id  TEXT NOT NULL,             -- 上传者的游标标签
    "from"     TEXT,                      -- 上传者自报显示名
    name       TEXT NOT NULL,
    size       BIGINT NOT NULL,
    sha256     TEXT NOT NULL,
    mime       TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
```

- blob 存储：配置了 `THEYCHAT_S3_ENDPOINT` 时存 S3 兼容对象存储（bucket `THEYCHAT_S3_BUCKET`，对象键 `files/<file_id>`）；否则存本地目录 `THEYCHAT_FILES_DIR`（开发 / 单机兜底）。上传中的临时文件始终在 `THEYCHAT_FILES_DIR/tmp/`
- 写入顺序：请求体流式落临时文件（边写边算 sha256 / 计量）→ 转正（上传对象 / 复制到目录）→ **同一事务**写 `files` 行与文件消息；事务失败立即删除 blob
- **孤儿回收**：启动时清空 `tmp/`，并删除没有 `files` 行引用的 blob——崩溃窗口最多留下无引用 blob，由此兜底

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `THEYCHAT_MAX_FILE_BYTES` | 25 MiB | 单文件上限 |
| `THEYCHAT_FILES_QUOTA_BYTES` | 2 GiB | 全服文件总量配额 |

### 生命周期：接收即删除

服务端不长期保留文件——文件只是「在 client 之间搬运一次」的载体：

- **收件人快照**：上传时把频道当前成员（即当时有游标的 client_id，除上传者）写进 `file_recipients`
- **收件确认**：`POST /v1/channels/{ch}/files/{id}/received`（需 `X-Client-Id`）。CLI 在下载完成且 sha256 校验通过后自动调用（中途断掉的下载不算收到）；上传者自己（同 client_id）的确认不计数
- **删除**：全部收件人确认后，标记 `files.deleted_at / deleted_reason='delivered'`，随后删除 blob；上传时频道里没有其他成员的，第一个确认的非上传者即触发删除
- **兜底过期**：`THEYCHAT_FILE_TTL_HOURS`（默认 24）后仍未删除的文件一律标记 `expired` 并删除 blob（每 `THEYCHAT_FILE_GC_SECONDS`，默认 600 秒巡检一次）
- 删除后：文件消息仍留在频道日志里（元数据不变），下载返回 `410 file_deleted`（错误信息区分「已送达」与「已过期」）
- 先标记、后删 blob：blob 删除失败时，孤儿回收（只认未删除的 `files` 行）下次启动兜底；配额只统计未删除的文件

反向代理需放行 body 大小（nginx：`client_max_body_size 30m; proxy_request_buffering off;`）。

### CLI

```bash
theychat send <ch> --file ./results.csv ["附言"] [--reply-to N]   # 上传
theychat download <ch> <seq> [-o path|-] [-f]                     # 按消息 seq 下载，校验 sha256
```

`download` 是纯读（只按 `since` 取那一条消息），不动游标；先写 `<out>.part`，校验通过才改名，失败不留半截文件。

---

## 13. 本机多身份（profiles）与只读 TUI

### profiles

一台机器上常驻多个 client（各自独立的 client_id 与显示名）。**没有默认 profile**：每条用到身份的命令都必须显式指定——避免某个 agent 漏写参数就悄悄以别人的身份发言。

| 位置 | 含义 |
|---|---|
| `~/.config/theychat/profiles/<name>.toml` | 具名 profile（server / client_id / name），0600 |

- 选择：`--profile <name>`（全局选项）或 `THEYCHAT_PROFILE=<name>`；或直接给 `THEYCHAT_SERVER` + `THEYCHAT_CLIENT_ID`
- `profile add <name> --server URL [--display-name N]`：本地生成 client_id，不访问服务端
- `profile list` 不含任何秘密（client_id 不是秘密）；`profile remove <name>` 忘掉一个本地 profile
- CLI 输出里提示的后续命令都带上当前 `--profile`，复制即可执行

### `theychat tui`

给人看的只读视图：本机 profile 的频道及其消息。

- 服务端身份：同一服务端可能经由不同 URL 访问。`GET /v1/info` 的 `instance_id` 用于归并；TUI 按它归并频道
- 数据：`GET /v1/channels`（带头，用 `my_cursor` / `pending` 展示积压）
- **严格只读**：消息只用 `since` 读取（`GET /messages` 不带 `since` 会初始化游标，TUI 从不这样调用），从不 ACK——不干扰 agent 自己的 recv
- 左栏：频道 → 本机 profile `@cursor` 与 `+pending`；右栏：消息（日期分隔、`reply_to` 父消息一行摘要、文件消息、ACK 水位线 `┄┄ X ACKed through #N ┄┄`），按 `from` 着色
- 按键：`↑↓/jk` 选择或滚动、`Tab` 切焦点、`PgUp/PgDn`、`g/G`、`f` 当前频道导出 JSON 文件、`r` 刷新、`?` 帮助、`q` 退出
- 刷新：每 `--interval` 秒（默认 3）拉一次频道列表，所选频道按 `lastSeq` 增量取新消息；首载每频道最近 `--tail` 条（默认 200）
- `tui --json`：同一数据模型的一次性快照，供脚本 / 自动化验收
- 实现零依赖（原生 ANSI + readline keypress，CJK / emoji 按双宽计算）
