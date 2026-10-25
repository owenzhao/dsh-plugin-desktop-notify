# dsh-plugin-desktop-notify

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面通知插件：
一轮跑完、我提问等你回答、有审批等你点的时候各弹一条。点通知会把 App 拉到前台，
**并直接打开发出这条通知的那条对话**。

不需要独立 App、不需要 `osascript`、不需要 shell hook。全部跑在 Harness 客户端里，
所以通知以 **DeepSeek Harness** 自己的身份发出（就是系统设置 → 通知里那条）。

[English](./README.md) | 简体中文

## 能做什么

| 时机 | 判断依据 | 通知 |
|---|---|---|
| 一轮结束 | 会话事件流里的 `turn/end` | 标题 = 会话名，正文 = 这条回复的第一行 |
| 我提问 | `ask_user_question` 的 `tool/call` | 正文 `在等你回答：<问题原文>` |
| 有审批 | 会话事件流里的 `approval/asked` | 正文 `需要批准：<工具名>` |
| 插件首次启用 | 每个浏览器配置一次 | 一条「通知已启用」的说明 |

- 点通知会切到发出它的那条会话。
- 如果你所在的平台点击通知只会把 App 拉到前台（macOS 上的 Electron 就是这样），
  插件会把「窗口重新获得焦点」当作点击，跳到同一条会话。
- 子智能体会话、空白会话会被跳过，避免多智能体并行时刷屏。

## 环境要求

- 带 Web 客户端的 DeepSeek Harness：桌面版，或 `dsh web`。
- 支持 Web Notifications 的平台。桌面版里通知归属 Harness App 本身；浏览器标签页里
  通知归属浏览器，所以推荐用桌面版。

## 安装

这是一个双面包：宿主半边（`lib/index.js`）+ 浏览器半边（`lib/client.js`）。
它像普通插件一样作为 profile 依赖安装，浏览器半边由 Loader 的一行启用后下发。

1. 装进你的 profile：

   ```sh
   # 发布到 npm 之后
   dsh plugin --profile <profile> add dsh-plugin-desktop-notify

   # 或者直接从源码目录安装
   dsh plugin --profile <profile> add link:/绝对路径/dsh-plugin-desktop-notify
   ```

   安装时 DSH 会警告「declares no dsh.bundle」，这是正常的：bundle 是整层 patch 层，
   而这里只是单个插件行。

2. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加一行：

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-plugin-desktop-notify
   ```

3. 重启 Harness。客户端启动图是在页面渲染时组装的，所以重启才会激活插件。

4. 系统询问时，允许 **DeepSeek Harness** 发送通知。首次启用会弹一条一次性说明，
   那次调用也正是触发权限询问的时机。

5. 可选：系统设置 → 通知 → DeepSeek Harness → 提醒样式 改成 **提醒（Persistent）**，
   通知就会一直停在屏幕上直到你点掉，而不是几秒后自己缩走。

## 配置

**设置 → 插件 → 桌面通知**（插件自己在那一页注册了一个 Tab）：

| 开关 | 默认 | 含义 |
|---|---|---|
| 启用通知 | 开 | 关掉后不再弹任何通知，插件仍然保持加载。 |
| 前台也提醒 | 开 | 关掉后，只有当你不在看那条会话时才提醒。 |

开关写入 `$DSH_HOME/state/desktop-notify.json`，下一次轮询就生效，**不用重启**。

Loader 行上的 `notifyInForeground` 仍然是**默认值**；设置页保存过的值优先于它：

```yaml
- insert:
    - id: desktop-notify
      name: dsh-plugin-desktop-notify
      config:
        notifyInForeground: false
```

## 实现

```
宿主半边（Node）                                浏览器半边
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│ 监听 session/event           │                 │ 每 2 秒轮询                  │
│  turn/end                    │   GET           │  /desktop-notify/pending     │
│  approval/asked      ────────┼──?after=<id>───▶│  ──▶ 系统通知                │
│  tool/call ask_user_question │                 │      点击 ──▶ openSession()  │
│ 队列 {id, sessionId, title}  │                 │ 窗口焦点 ──▶ openSession()   │
└──────────────────────────────┘                 └──────────────────────────────┘
```

浏览器端的客户端接口只暴露「会话列表」，审批和提问根本到不了它手上。所以宿主半边
改去监听会话事件流，维护一个短队列，用一个只读路由发出去。这样每条通知都带着它
所属的 `sessionId`，点击才能准确跳到对应对话。

浏览器半边保留了兜底：如果那个路由拿不到（比如没有 Web 服务器的组合），就退回到
监听会话列表的「运行中 → 已结束」，至少覆盖最常见的情况。

## 排查

- 在 Harness 窗口地址后加 `?notify-debug`，左下角会显示状态行，包含最近一次动作
  （`sent:`、`skip(...)`、`open failed: …`）。
- 直接看队列：

  ```sh
  curl "http://127.0.0.1:<端口>/desktop-notify/pending?after=0"
  ```

  返回 `200` 和 `{"notifications":[...]}` 就说明宿主半边在跑。
- 完全没通知：先确认系统设置里 **DeepSeek Harness** 的通知是允许的，再看提醒样式。
- 点击只把 App 拉到前台、没切会话：这是上面说的 Electron 限制，正常由焦点兜底解决；
  如果仍失败，状态行里会有 `open failed: …` 和具体原因。

## 已知限制

- 只在 Harness 窗口开着时才有通知，没有后台进程。
- 页面是轮询的，事件到弹出之间最多约 2 秒延迟。
- 通知权限属于 Harness App，插件无法替你授予。
- 还没发布到 npm，目前按上面的方式从源码安装。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
