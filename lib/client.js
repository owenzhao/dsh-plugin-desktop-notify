window.__ModuleLoader__.load({
	id: "dsh-plugin-desktop-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/** Services this browser plugin waits for before `apply` runs. */
		const inject = ["sessions", "uiSession", "uiWorkspace", "slots"];
		/** How often the page asks the host half for "the user is needed" moments. */
		const POLL_MS = 2000;
		/** localStorage key remembering that the one-time hello was shown. */
		const HELLO_KEY = "dsh.notify.hello-shown";
		/** `?notify-debug` turns on the on-page status line. */
		const DEBUG = (() => {
			try {
				return new URLSearchParams(window.location.search).has("notify-debug");
			} catch (error) {
				return false;
			}
		})();

		/** Notifications still on screen; keeping them referenced preserves click handlers. */
		const live = new Set();
		/** Notifications sent while unfocused: coming back to the app should return to their Session. */
		const awaitingOpen = [];
		/** Last thing the plugin did, surfaced in the status line while debugging. */
		let lastNote = "none";

		function debugLine(text) {
			if (!DEBUG) return;
			try {
				let node = document.getElementById("dsh-notify-debug");
				if (!node) {
					node = document.createElement("div");
					node.id = "dsh-notify-debug";
					node.style.cssText =
						"position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:6px 10px;border-radius:8px;" +
						"background:rgba(0,0,0,.78);color:#fff;font:12px/1.4 -apple-system,sans-serif;max-width:560px";
					(document.body || document.documentElement).appendChild(node);
				}
				node.textContent = `desktop-notify: ${text}`;
			} catch (error) {}
		}

		/** Short-lived on-page confirmation, so a notification click is visibly acknowledged. */
		function toast(text, duration = 2500) {
			try {
				const node = document.createElement("div");
				node.textContent = text;
				node.style.cssText =
					"position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;" +
					"padding:8px 14px;border-radius:9px;background:rgba(0,0,0,.82);color:#fff;" +
					"font:13px/1.4 -apple-system,sans-serif;pointer-events:none";
				(document.body || document.documentElement).appendChild(node);
				setTimeout(() => node.remove(), duration);
			} catch (error) {}
		}

		function supported() {
			return typeof Notification !== "undefined";
		}

		async function ensurePermission() {
			if (!supported()) return false;
			if (Notification.permission === "granted") return true;
			if (Notification.permission === "denied") return false;
			try {
				return (await Notification.requestPermission()) === "granted";
			} catch (error) {
				return false;
			}
		}

		/**
		 * Raise one notification.
		 * @param title - normally the Session's display title.
		 * @param body - what the user has to do or look at.
		 * @param onClick - focus the app and open the Session.
		 */
		function show(title, body, onClick) {
			if (!supported() || Notification.permission !== "granted") {
				lastNote = `skip(permission=${supported() ? Notification.permission : "no-api"})`;
				debugLine(lastNote);
				return;
			}
			try {
				const notification = new Notification(title, { body });
				live.add(notification);
				awaitingOpen.push({ at: Date.now(), open: onClick, notification });
				notification.onclick = () => {
					live.delete(notification);
					const index = awaitingOpen.findIndex((entry) => entry.notification === notification);
					if (index >= 0) awaitingOpen.splice(index, 1);
					try {
						window.focus();
						if (onClick) onClick();
					} catch (error) {
						toast(`打开会话失败：${error && error.message}`, 8000);
					} finally {
						try {
							notification.close();
						} catch (error) {}
					}
				};
				notification.onclose = () => live.delete(notification);
				lastNote = `sent: ${title} / ${body}`;
				debugLine(lastNote);
			} catch (error) {
				lastNote = `failed: ${error && error.message}`;
				debugLine(lastNote);
			}
		}

		/** Switch the app to a Session; the client's navigation service owns the view. */
		function openSession(ctx, id) {
			const workspace = ctx.uiWorkspace;
			if (workspace && typeof workspace.openSession === "function") {
				workspace.openSession(id);
				return;
			}
			if (ctx.sessions && typeof ctx.sessions.open === "function") {
				ctx.sessions.open(id);
				return;
			}
			throw new Error("no session-navigation service available");
		}

		/** The Session currently shown, when the client exposes its selection. */
		function currentSessionId(ctx) {
			try {
				const selection = ctx.uiWorkspace && ctx.uiWorkspace.selection;
				const value = selection && typeof selection.getSnapshot === "function" ? selection.getSnapshot() : undefined;
				return value && value.sessionId;
			} catch (error) {
				return undefined;
			}
		}

		function apply(ctx) {
			try {
				install(ctx);
			} catch (error) {
				lastNote = `apply failed: ${error && error.message}`;
				debugLine(lastNote);
			}
		}


		/** One labelled switch row inside the settings tab. */
		function SwitchRow({ title, hint, checked, onChange }) {
			return React.createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 16,
						padding: "14px 0",
						borderBottom: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))"
					}
				},
				React.createElement(
					"div",
					null,
					React.createElement(
						"div",
						{ style: { fontSize: 14, color: "var(--dsw-alias-label-primary, inherit)" } },
						title
					),
					hint
						? React.createElement(
								"div",
								{ style: { fontSize: 12, marginTop: 4, color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.55))" } },
								hint
							)
						: null
				),
				React.createElement("input", {
					type: "checkbox",
					checked: Boolean(checked),
					onChange: (event) => onChange(event.target.checked),
					style: { width: 18, height: 18, cursor: "pointer", accentColor: "#0a84ff" }
				})
			);
		}

		/** Settings → Plugins tab: the plugin's runtime switches. */
		function DesktopNotifySettings() {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetch("/desktop-notify/config", { cache: "no-store" })
					.then((response) => response.json())
					.then((value) => {
						if (alive) setState(value);
					})
					.catch((reason) => {
						if (alive) setError(String(reason && reason.message ? reason.message : reason));
					});
				return () => {
					alive = false;
				};
			}, []);

			const update = (patch) => {
				setState((previous) => ({ ...(previous ?? {}), ...patch }));
				fetch("/desktop-notify/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch)
				})
					.then((response) => response.json())
					.then((value) => {
						setState(value);
						setError("");
					})
					.catch((reason) => setError(String(reason && reason.message ? reason.message : reason)));
			};

			if (error) {
				return React.createElement(
					"div",
					{ style: { padding: 16, fontSize: 13, color: "var(--dsw-alias-state-error-primary, #c00)" } },
					`读取设置失败：${error}`
				);
			}
			if (state === null) {
				return React.createElement("div", { style: { padding: 16, fontSize: 13, opacity: 0.7 } }, "读取中…");
			}

			return React.createElement(
				"div",
				{ style: { padding: "4px 0 8px" } },
				React.createElement(
					"div",
					{ style: { fontSize: 13, opacity: 0.7, padding: "8px 0 4px" } },
					"回合结束、等你回答、等你批准时弹系统通知；点通知会回到对应对话。"
				),
				React.createElement(SwitchRow, {
					title: "启用通知",
					hint: "关掉后不再弹任何通知，插件仍保持加载。",
					checked: state.enabled !== false,
					onChange: (checked) => update({ enabled: checked })
				}),
				React.createElement(SwitchRow, {
					title: "前台也提醒",
					hint: "关掉后，只有当你不在看那条会话时才提醒。",
					checked: state.notifyInForeground !== false,
					onChange: (checked) => update({ notifyInForeground: checked })
				})
			);
		}

		/** Mount the tab into Settings → Plugins. */
		function registerSettingsTab(ctx) {
			try {
				ctx.slots.inject("settings.plugins.tab", () =>
					ctx.slots.register(
						{
							name: "settings.plugins.tab",
							id: "desktop-notify",
							order: 40,
							label: () => "桌面通知"
						},
						DesktopNotifySettings
					)
				);
			} catch (error) {
				debugLine(`settings tab failed: ${error && error.message}`);
			}
		}

		function install(ctx) {
			registerSettingsTab(ctx);

			let notifyInForeground = true;
			let hostFeedWorks = false;
			let cursor = 0;
			let seeded = false;

			async function poll() {
				try {
					const response = await fetch(`/desktop-notify/pending?after=${cursor}`, { cache: "no-store" });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					hostFeedWorks = true;
					if (typeof data.notifyInForeground === "boolean") notifyInForeground = data.notifyInForeground;
					const items = Array.isArray(data.notifications) ? data.notifications : [];
					const newest = items.reduce((max, item) => (typeof item.id === "number" && item.id > max ? item.id : max), cursor);
					if (!seeded) {
						// The queue may hold moments from before this page loaded.
						cursor = newest;
						seeded = true;
						return;
					}
					cursor = newest;
					for (const item of items) {
						if (!item || typeof item.sessionId !== "string") continue;
						const focused = typeof document !== "undefined" && document.hasFocus();
						if (!notifyInForeground && focused && item.sessionId === currentSessionId(ctx)) {
							lastNote = `skip(focused,current) ${item.title}`;
							debugLine(lastNote);
							continue;
						}
						// Prefer the client's own title: a Session resumed after a restart
						// never re-emits its `session/title` event, so the host only has the
						// working-directory fallback.
						const row = snapshotOf(ctx.sessions.list);
						const known = row && row.byId ? row.byId[item.sessionId] : undefined;
						const title = (known && known.displayTitle) || item.title || "DeepSeek Harness";
						show(title, item.body || "需要你看一眼", () => openSession(ctx, item.sessionId));
					}
				} catch (error) {
					debugLine(`poll failed: ${error && error.message}`);
				}
			}

			// Fallback for a client whose host half serves no route: watch the Session
			// list for a running → finished transition.
			const list = ctx.sessions.list;
			const running = new Map();
			let listSeeded = false;
			const snapshotOf = (source) => {
				try {
					return source && typeof source.getSnapshot === "function" ? source.getSnapshot() : undefined;
				} catch (error) {
					return undefined;
				}
			};
			const fallbackEvaluate = () => {
				if (hostFeedWorks) return;
				const state = snapshotOf(list);
				if (!state || !Array.isArray(state.ids)) return;
				for (const id of state.ids) {
					const row = state.byId ? state.byId[id] : undefined;
					if (!row) continue;
					const wasRunning = running.get(id);
					running.set(id, row.running === true);
					if (!listSeeded) continue;
					if (wasRunning !== true || row.running === true) continue;
					if (row.origin === "subagent" || row.blank === true) continue;
					show(row.displayTitle || "DeepSeek Harness", "回合结束", () => openSession(ctx, id));
				}
				listSeeded = true;
			};

			const unsubscribers = [];
			try {
				if (typeof list.subscribe === "function") unsubscribers.push(list.subscribe(fallbackEvaluate));
			} catch (error) {
				// The host feed is the primary path anyway.
			}

			try {
				fallbackEvaluate();
			} catch (error) {}

			void poll();
			const timer = setInterval(() => void poll(), POLL_MS);
			unsubscribers.push(() => clearInterval(timer));

			debugLine(`ready (permission=${supported() ? Notification.permission : "no-api"})`);

			// Electron does not always deliver a notification click to the page; the app
			// simply comes to the front. Treat that activation as the click.
			const onFocus = () => {
				const now = Date.now();
				const fresh = awaitingOpen.filter((entry) => now - entry.at < 5 * 60 * 1000);
				if (fresh.length === 0) return;
				const entry = fresh[fresh.length - 1];
				awaitingOpen.length = 0;
				setTimeout(() => {
					try {
						entry.open();
						lastNote = "opened after focus";
						toast("已回到对应会话");
					} catch (error) {
						lastNote = `open failed: ${error && error.message}`;
						debugLine(lastNote);
						toast(`打开会话失败：${error && error.message}`, 8000);
					}
					try {
						entry.notification.close();
					} catch (error) {}
				}, 350);
			};
			window.addEventListener("focus", onFocus);
			unsubscribers.push(() => window.removeEventListener("focus", onFocus));

			ctx.effect(
				() => () => {
					for (const unsubscribe of unsubscribers) {
						try {
							if (typeof unsubscribe === "function") unsubscribe();
						} catch (error) {
							// Disposal stays best-effort.
						}
					}
				},
				"desktop-notify: subscriptions"
			);

			// One-time hello: makes the plugin visibly live and lets macOS ask for the
			// notification permission up front instead of mid-task.
			void ensurePermission().then((granted) => {
				if (!granted) return;
				try {
					if (window.localStorage.getItem(HELLO_KEY) === "1") return;
					window.localStorage.setItem(HELLO_KEY, "1");
				} catch (error) {
					return;
				}
				show("DeepSeek Harness", "桌面通知已启用：回合结束、提问、审批时提醒你", undefined);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
