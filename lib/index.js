/**
 * Host half of dsh-plugin-desktop-notify.
 *
 * The browser half owns presentation (it raises the system notification and
 * navigates on click), but the client API only exposes the Session list —
 * approvals and user questions never reach it. The host therefore watches the
 * Session event firehose, keeps a short queue of "the user is needed" moments,
 * and serves it on one tiny route the page polls.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROUTE = "/desktop-notify/pending";
const CONFIG_ROUTE = "/desktop-notify/config";
/** Runtime switches live outside the Loader row so the GUI can change them. */
const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "state");
const STATE_FILE = join(STATE_DIR, "desktop-notify.json");
const MAX_QUEUE = 32;

/** Current runtime switches: `{ enabled, notifyInForeground }`. */
function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8")) ?? {};
	} catch {
		return {};
	}
}

function writeState(patch) {
	const next = { ...readState(), ...patch };
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 1)}\n`);
	} catch {
		// A read-only home only loses the toggle, never the notifications.
	}
	return next;
}

/** One queued notification the browser has not consumed yet. */
let nextId = 1;

export function apply(ctx, config) {
	const rowNotifyInForeground = !config || config.notifyInForeground !== false;
	const settings = () => {
		const state = readState();
		return {
			enabled: state.enabled !== false,
			notifyInForeground:
				typeof state.notifyInForeground === "boolean" ? state.notifyInForeground : rowNotifyInForeground
		};
	};
	/** Consumed-by-id queue; the browser asks for everything after its cursor. */
	let queue = [];
	const titles = new Map();
	/** Last assistant reply per Session — the point of the finished turn. */
	const lastReply = new Map();

	const titleOf = (session) => {
		const id = session?.header?.id;
		const title = id === undefined ? undefined : titles.get(id);
		if (title) return title;
		const cwd = session?.header?.cwd ?? "";
		const base = cwd.split("/").filter(Boolean).pop();
		return base || "DeepSeek Harness";
	};

	/** Text blocks of one assistant message. */
	const textOf = (message) => {
		const parts = message?.content;
		if (!Array.isArray(parts)) return "";
		return parts
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
	};

	/** First meaningful line, collapsed and capped. */
	const pick = (text, max = 88) => {
		if (!text) return "";
		const line = text.split("\n").map((item) => item.trim()).find((item) => item.length > 0) ?? "";
		const flat = line.replace(/\s+/g, " ");
		return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
	};

	/** The user's question text out of an `ask_user_question` call. */
	const questionOf = (raw) => {
		try {
			const parsed = JSON.parse(raw);
			const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : parsed;
			return typeof first?.question === "string" ? first.question : "";
		} catch (error) {
			return "";
		}
	};

	const push = (session, kind, body) => {
		const sessionId = session?.header?.id;
		if (sessionId === undefined) return;
		if (!settings().enabled) return;
		queue.push({
			id: nextId++,
			at: Date.now(),
			kind,
			sessionId,
			title: titleOf(session),
			body
		});
		if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
	};

	ctx.on("session/event", (session, event) => {
		try {
			const id = session?.header?.id;
			if (id === undefined) return;
			switch (event?.type) {
				case "session/title":
					if (typeof event.data?.title === "string") titles.set(id, event.data.title);
					return;
				case "assistant/message":
					lastReply.set(id, textOf(event.data?.message));
					return;
				case "turn/end": {
					const summary = pick(lastReply.get(id) ?? "");
					push(session, "stop", summary || "回合结束");
					return;
				}
				case "approval/asked": {
					const tool = event.data?.toolName ?? "工具";
					push(session, "approval", `需要批准：${tool}`);
					return;
				}
				case "tool/call":
					if (event.data?.name === "ask_user_question") {
						const question = pick(questionOf(event.data?.arguments), 80);
						push(session, "question", question ? `在等你回答：${question}` : "在等你回答");
					}
					return;
				default:
					return;
			}
		} catch (error) {
			// A notification must never disturb the run.
		}
	});

	ctx.inject(["webServer"], (scoped) => {
		try {
			const dispose = scoped.webServer.register({
				kind: "exact",
				path: ROUTE,
				handler: (req, res) => {
					const url = new URL(req.url ?? ROUTE, "http://127.0.0.1");
					const after = Number(url.searchParams.get("after") ?? "0");
					const cursor = Number.isFinite(after) ? after : 0;
					const notifications = queue.filter((item) => item.id > cursor);
					res.setHeader("content-type", "application/json; charset=utf-8");
					res.setHeader("cache-control", "no-store");
					const current = settings();
					res.end(JSON.stringify({ notifications, ...current }));
				}
			});
			scoped.effect(() => dispose, "desktop-notify: pending route");

			const disposeConfig = scoped.webServer.register({
				kind: "exact",
				path: CONFIG_ROUTE,
				handler: (req, res) => {
					res.setHeader("content-type", "application/json; charset=utf-8");
					res.setHeader("cache-control", "no-store");
					if (req.method === "POST") {
						let body = "";
						req.on("data", (chunk) => {
							body += chunk;
							if (body.length > 4096) req.destroy();
						});
						req.on("end", () => {
							try {
								const patch = JSON.parse(body || "{}");
								const clean = {};
								if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
								if (typeof patch.notifyInForeground === "boolean") clean.notifyInForeground = patch.notifyInForeground;
								writeState(clean);
								res.end(JSON.stringify(settings()));
							} catch (error) {
								res.statusCode = 400;
								res.end(JSON.stringify({ error: "invalid JSON body" }));
							}
						});
						return;
					}
					res.end(JSON.stringify(settings()));
				}
			});
			scoped.effect(() => disposeConfig, "desktop-notify: config route");
		} catch (error) {
			// Running without a web server (headless) simply has no browser half.
		}
	});
}
