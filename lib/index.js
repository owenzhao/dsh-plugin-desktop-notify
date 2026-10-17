/**
 * Host half of dsh-plugin-desktop-notify.
 *
 * The browser half owns presentation (it raises the system notification and
 * navigates on click), but the client API only exposes the Session list —
 * approvals and user questions never reach it. The host therefore watches the
 * Session event firehose, keeps a short queue of "the user is needed" moments,
 * and serves it on one tiny route the page polls.
 */
const ROUTE = "/desktop-notify/pending";
const MAX_QUEUE = 32;

/** One queued notification the browser has not consumed yet. */
let nextId = 1;

export function apply(ctx, config) {
	const notifyInForeground = !config || config.notifyInForeground !== false;
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
					res.end(JSON.stringify({ notifications, notifyInForeground }));
				}
			});
			scoped.effect(() => dispose, "desktop-notify: pending route");
		} catch (error) {
			// Running without a web server (headless) simply has no browser half.
		}
	});
}
