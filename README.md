# dsh-plugin-desktop-notify

Desktop notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
one ping when a turn finishes, when the agent asks you a question, and when an
approval is waiting. Clicking a notification brings the app forward **and opens the
conversation that raised it**.

No helper app, no `osascript`, no shell hooks. Everything runs inside the Harness
client, so the notification is delivered under the **DeepSeek Harness** identity
(the same one macOS shows in 系统设置 → 通知).

English | [简体中文](./README.zh.md)

## Features

| Moment | Detected from | Notification |
|---|---|---|
| A turn finishes | `turn/end` in the Session event stream | title = Session title, body = the first line of the reply |
| The agent asks a question | a `tool/call` of `ask_user_question` | body = `在等你回答：<the question>` |
| An approval is waiting | `approval/asked` in the Session event stream | body = `需要批准：<tool name>` |
| Plugin first activated | once per browser profile | a "notifications enabled" hello |

- Clicking a notification opens the Session that raised it.
- If your platform only activates the app on click (Electron on macOS does this), the
  app coming to the foreground is treated as the click and the same Session is opened.
- Subagent Sessions and blank Sessions are skipped, so a fan-out does not spam you.

## Requirements

- DeepSeek Harness with the web client — the desktop app or `dsh web`.
- A platform that supports the Web Notifications API. In the desktop app the
  notification belongs to the Harness app itself; in a browser tab it belongs to the
  browser, so the desktop app is the intended target.

## Install

The plugin is a dual-face package: a host half (`lib/index.js`) and a browser half
(`lib/client.js`). It installs as an ordinary profile dependency, and the Loader
serves the browser half from an enabled row.

1. Install it into your profile:

   ```sh
   # from npm, once published
   dsh plugin --profile <profile> add dsh-plugin-desktop-notify

   # or straight from a checkout
   dsh plugin --profile <profile> add link:/absolute/path/to/dsh-plugin-desktop-notify
   ```

   DSH warns that the package "declares no dsh.bundle". That is expected: a bundle is
   a whole patch layer, while this is a single plugin row.

2. Add the row to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-plugin-desktop-notify
   ```

3. Restart the Harness app. The client boot graph is composed when the page renders,
   so a restart is what activates the plugin.

4. Allow notifications for **DeepSeek Harness** when the system asks. The first
   activation raises a one-time "notifications enabled" notification, which is also
   what triggers the permission prompt.

5. Optional: set 系统设置 → 通知 → DeepSeek Harness → **Alert Style** to
   *Persistent* if you want the banner to stay until dismissed instead of sliding
   away after a few seconds.

## Configuration

Configuration lives on the Loader row. The host half reads it and forwards it to the
browser in the same response the page polls, because the client boot graph carries no
per-row config.

| Key | Default | Meaning |
|---|---|---|
| `notifyInForeground` | `true` | Also notify while the app window has focus. Set to `false` to stay quiet when you are already looking at the Session that just finished. |

```yaml
- insert:
    - id: desktop-notify
      name: dsh-plugin-desktop-notify
      config:
        notifyInForeground: false
```

With `notifyInForeground: false`, a turn that ends in the Session you are currently
viewing, while the app has focus, is skipped. Every other case — another Session,
another app — still notifies.

## How it works

```
host half (Node)                                  browser half
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│ session/event firehose       │                 │ polls every 2s               │
│  turn/end                    │   GET           │  /desktop-notify/pending     │
│  approval/asked      ────────┼──?after=<id>───▶│  ──▶ Web Notification        │
│  tool/call ask_user_question │                 │      click ──▶ openSession() │
│ queue {id, sessionId, title} │                 │  focus ──────▶ openSession() │
└──────────────────────────────┘                 └──────────────────────────────┘
```

The browser client only exposes the Session list — approvals and questions never
reach it. The host half watches the Session event firehose instead and keeps a short
queue, served on one read-only route. That is what lets every notification carry the
`sessionId` it belongs to, so a click always navigates to the right conversation.

The browser half keeps a fallback: if the route is unavailable (a composition without
a web server), it falls back to watching the Session list for a running → finished
transition, which still covers the most common case.

## Troubleshooting

- Open the Harness window with `?notify-debug` appended to its URL to show a status
  line in the bottom-left corner:
  `desktop-notify: running=…` and the last action taken (`sent:`, `skip(...)`,
  `open failed: …`).
- Check the queue directly:

  ```sh
  curl "http://127.0.0.1:<port>/desktop-notify/pending?after=0"
  ```

  A `200` with `{"notifications":[...]}` means the host half is running.
- No notification at all: check that notifications are allowed for **DeepSeek
  Harness** in the system settings, and that the Alert Style is not fighting you.
- Clicking focuses the app but does not switch Sessions: this is the Electron
  limitation described above; the focus fallback is what normally resolves it. If it
  still fails, the status line reports `open failed: …` with the reason.

## Limitations

- Notifications are only raised while a Harness window is open; nothing runs in the
  background.
- The page polls, so the delay between the event and the banner is up to ~2 seconds.
- Notification permission belongs to the Harness app; the plugin cannot grant it.
- The plugin is not published to npm yet; install it from a checkout as shown above.

## License

MIT — see [LICENSE](./LICENSE).
