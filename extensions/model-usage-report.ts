import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_ID = "model-usage";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const EXTENSION_DIR = join(AGENT_DIR, "extensions", "pi-extension");
const STORE_DIR = join(EXTENSION_DIR, "model-usage");
const LEGACY_STORE_FILE = join(AGENT_DIR, "codex-usage", "sessions.json");
const LEGACY_MODEL_USAGE_FILE = join(AGENT_DIR, "model-usage", "sessions.json");
const STORE_FILE = join(STORE_DIR, "sessions.json");
const CONFIG_FILE = join(STORE_DIR, "config.json");

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
};

type TurnUsage = {
	index: number;
	userRound: number;
	time?: string;
	provider?: string;
	model?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

type SessionUsage = {
	sessionFile: string;
	cwd: string;
	updatedAt: string;
	turns: TurnUsage[];
	totals: Omit<TurnUsage, "index" | "userRound" | "time" | "provider" | "model">;
};

type QuotaSettings = {
	fiveHourTokens?: number;
	weeklyTokens?: number;
};

type Store = {
	version: 1;
	sessions: Record<string, SessionUsage>;
	quota?: QuotaSettings;
};

type SessionGroup = {
	id: string;
	title: string;
	session: SessionUsage;
	maxTurnTokens: number;
};

type Report = {
	lines: string[];
	groups: SessionGroup[];
	footer: string[];
};

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const money = (value: number): string => `$${value.toFixed(value >= 1 ? 4 : 6)}`;
const tokens = (value: number): string => value.toLocaleString();
const compactTokens = (value: number): string => {
	if (value < 1000) return `${Math.round(value)}`;
	if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
	return `${(value / 1000000).toFixed(value < 10000000 ? 1 : 0)}M`;
};
const parseQuota = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const match = value.trim().toLowerCase().match(/^([0-9]+(?:\.[0-9]+)?)(k|m|b)?$/);
	if (!match) return undefined;
	const base = Number(match[1]);
	const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
	return Number.isFinite(base) && base > 0 ? Math.round(base * multiplier) : undefined;
};
const quotaPct = (used: number, quota: number | undefined): string => quota ? `${((used / quota) * 100).toFixed(2)}%` : "未设置";
const quotaText = (used: number, quota: number | undefined): string => quota ? `${used.toLocaleString()} / ${quota.toLocaleString()} calls (${quotaPct(used, quota)})` : `${used.toLocaleString()} calls / 未设置`;
const padLeft = (value: string, width: number): string => value.padStart(width, " ");
const percent = (part: number, total: number): string => total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0.0%";

function bar(value: number, max: number, width = 22): string {
	if (max <= 0) return "░".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function shortSessionName(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts.slice(-2).join("/") || path;
}

function renderSessionGroup(group: SessionGroup, expanded: boolean, selected: boolean): string[] {
	const marker = expanded ? "▾" : "▸";
	const cursor = selected ? "›" : " ";
	const s = group.session;
	const header = `${cursor} ${marker} ${padLeft(compactTokens(s.totals.totalTokens), 8)} tok  ${padLeft(money(s.totals.cost), 10)}  ${padLeft(String(s.turns.length), 4)} calls  ${group.title}`;
	if (!expanded) return [header];

	const lines = [header, "      #   轮次  用量条                  Tokens      Cost       模型 / 输入输出缓存"];
	if (s.turns.length === 0) {
		lines.push("      暂无模型调用记录");
		return lines;
	}
	for (const turn of s.turns) {
		const io = `↑${compactTokens(turn.input)} ↓${compactTokens(turn.output)} R${compactTokens(turn.cacheRead)} W${compactTokens(turn.cacheWrite)}`;
		const codex = isCodexTurn(turn) ? " [Codex]" : "";
		lines.push(`      ${padLeft(String(turn.index), 2)}  ${padLeft(String(turn.userRound), 4)}  ${bar(turn.totalTokens, group.maxTurnTokens)}  ${padLeft(compactTokens(turn.totalTokens), 8)}  ${padLeft(money(turn.cost), 10)}  ${modelName(turn)}${codex} ${io}`);
	}
	return lines;
}

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.cwd}`;
}

function emptyTotals(): SessionUsage["totals"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function defaultQuota(): QuotaSettings {
	return {
		fiveHourTokens: parseQuota(process.env.PI_CODEX_5H_TOKEN_QUOTA),
		weeklyTokens: parseQuota(process.env.PI_CODEX_WEEKLY_TOKEN_QUOTA),
	};
}

function addUsage(target: SessionUsage["totals"], usage: Pick<TurnUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "cost">) {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost += usage.cost;
}

function modelName(turn: TurnUsage): string {
	return [turn.provider, turn.model].filter(Boolean).join("/") || "unknown";
}

function isCodexTurn(turn: TurnUsage): boolean {
	const provider = (turn.provider ?? "").toLowerCase();
	const model = (turn.model ?? "").toLowerCase();
	return provider.includes("codex") || model.includes("codex") || (provider.includes("openai") && model.includes("gpt-5-codex"));
}

function extractUsage(raw: Usage | undefined, index: number, userRound: number, message: any): TurnUsage {
	const input = n(raw?.input);
	const output = n(raw?.output);
	const cacheRead = n(raw?.cacheRead);
	const cacheWrite = n(raw?.cacheWrite);
	const totalTokens = n(raw?.totalTokens) || input + output + cacheRead + cacheWrite;
	return {
		index,
		userRound,
		time: typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : undefined,
		provider: typeof message.provider === "string" ? message.provider : undefined,
		model: typeof message.model === "string" ? message.model : undefined,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: n(raw?.cost?.total),
	};
}

function computeSessionUsage(ctx: ExtensionContext): SessionUsage {
	const turns: TurnUsage[] = [];
	let userRound = 0;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;
		if (message.role === "user") userRound += 1;
		if (message.role === "assistant" && message.usage) {
			turns.push(extractUsage(message.usage, turns.length + 1, Math.max(1, userRound), message));
		}
	}

	const totals = emptyTotals();
	for (const turn of turns) addUsage(totals, turn);

	return {
		sessionFile: sessionKey(ctx),
		cwd: ctx.cwd,
		updatedAt: new Date().toISOString(),
		turns,
		totals,
	};
}

function loadQuotaFromConfig(): QuotaSettings {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as QuotaSettings;
	} catch {
		return {};
	}
}

function loadStore(): Store {
	const envQuota = defaultQuota();
	const configQuota = loadQuotaFromConfig();
	try {
		const source = existsSync(STORE_FILE)
			? STORE_FILE
			: existsSync(LEGACY_MODEL_USAGE_FILE)
				? LEGACY_MODEL_USAGE_FILE
				: LEGACY_STORE_FILE;
		const store = JSON.parse(readFileSync(source, "utf8")) as Store;
		store.quota = {
			fiveHourTokens: envQuota.fiveHourTokens ?? configQuota.fiveHourTokens ?? store.quota?.fiveHourTokens,
			weeklyTokens: envQuota.weeklyTokens ?? configQuota.weeklyTokens ?? store.quota?.weeklyTokens,
		};
		return store;
	} catch {
		return { version: 1, sessions: {}, quota: { ...configQuota, ...envQuota } };
	}
}

function saveSnapshot(ctx: ExtensionContext): SessionUsage {
	const snapshot = computeSessionUsage(ctx);
	mkdirSync(STORE_DIR, { recursive: true });
	const store = loadStore();
	store.sessions[snapshot.sessionFile] = snapshot;
	writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
	return snapshot;
}

function sumTurns(turns: TurnUsage[], predicate: (turn: TurnUsage) => boolean = () => true): SessionUsage["totals"] {
	const totals = emptyTotals();
	for (const turn of turns) {
		if (predicate(turn)) addUsage(totals, turn);
	}
	return totals;
}

function countTurns(turns: TurnUsage[], predicate: (turn: TurnUsage) => boolean = () => true): number {
	return turns.filter(predicate).length;
}

function windowTurnCount(sessions: SessionUsage[], sinceMs: number, predicate: (turn: TurnUsage) => boolean = () => true): number {
	let count = 0;
	for (const session of sessions) {
		for (const turn of session.turns) {
			const time = turn.time ? Date.parse(turn.time) : Date.parse(session.updatedAt);
			if (Number.isFinite(time) && time >= sinceMs && predicate(turn)) count += 1;
		}
	}
	return count;
}

function saveQuota(quota: QuotaSettings) {
	mkdirSync(STORE_DIR, { recursive: true });
	const current = loadStore().quota ?? {};
	const next = { ...current, ...quota };
	writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
}

function buildReport(current: SessionUsage, store: Store, mode: "current" | "all"): Report {
	const lines: string[] = [];
	const sessions = Object.values(store.sessions);
	const grand = emptyTotals();
	for (const s of sessions) {
		grand.input += s.totals.input;
		grand.output += s.totals.output;
		grand.cacheRead += s.totals.cacheRead;
		grand.cacheWrite += s.totals.cacheWrite;
		grand.totalTokens += s.totals.totalTokens;
		grand.cost += s.totals.cost;
	}

	const maxSessionTokens = Math.max(0, ...sessions.map((s) => s.totals.totalTokens));
	const avgTurnTokens = current.turns.length ? Math.round(current.totals.totalTokens / current.turns.length) : 0;
	const avgTurnCost = current.turns.length ? current.totals.cost / current.turns.length : 0;
	const now = Date.now();
	const currentCodexTotals = sumTurns(current.turns, isCodexTurn);
	const currentCodexCalls = countTurns(current.turns, isCodexTurn);
	const fiveHourCodexCalls = windowTurnCount(sessions, now - 5 * 60 * 60 * 1000, isCodexTurn);
	const weeklyCodexCalls = windowTurnCount(sessions, now - 7 * 24 * 60 * 60 * 1000, isCodexTurn);
	const quota = store.quota ?? {};

	lines.push("模型 / Token 使用看板");
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	lines.push(`当前会话  ${padLeft(compactTokens(current.totals.totalTokens), 8)} tok  ${padLeft(money(current.totals.cost), 10)}  ${current.turns.length} calls`);
	lines.push(`平均每次  ${padLeft(compactTokens(avgTurnTokens), 8)} tok  ${padLeft(money(avgTurnCost), 10)}`);
	lines.push(`全部会话  ${padLeft(compactTokens(grand.totalTokens), 8)} tok  ${padLeft(money(grand.cost), 10)}  ${sessions.length} sessions`);
	lines.push("");

	if (currentCodexCalls > 0 || fiveHourCodexCalls > 0 || weeklyCodexCalls > 0) {
		lines.push("Codex 额度消耗百分比");
		lines.push(`  本次对话 Codex 占 5h 额度   ${quotaText(currentCodexCalls, quota.fiveHourTokens)}`);
		lines.push(`  本次对话 Codex 占周额度      ${quotaText(currentCodexCalls, quota.weeklyTokens)}`);
		lines.push(`  最近 5h Codex 已用额度      ${quotaText(fiveHourCodexCalls, quota.fiveHourTokens)}`);
		lines.push(`  最近 7天 Codex 已用额度      ${quotaText(weeklyCodexCalls, quota.weeklyTokens)}`);
		lines.push(`  本次对话 Codex token         ${compactTokens(currentCodexTotals.totalTokens)} tok（仅展示，不用于额度百分比）`);
		if (!quota.fiveHourTokens || !quota.weeklyTokens) {
			lines.push("  提示: /usage quota 5h=150 week=1000 可设置 Codex 调用次数额度上限");
		}
		lines.push("");
	}

	lines.push("当前会话 token 构成");
	lines.push(`  ↑ 输入       ${padLeft(tokens(current.totals.input), 12)}  ${padLeft(percent(current.totals.input, current.totals.totalTokens), 6)}`);
	lines.push(`  ↓ 输出       ${padLeft(tokens(current.totals.output), 12)}  ${padLeft(percent(current.totals.output, current.totals.totalTokens), 6)}`);
	lines.push(`  R 缓存读     ${padLeft(tokens(current.totals.cacheRead), 12)}  ${padLeft(percent(current.totals.cacheRead, current.totals.totalTokens), 6)}`);
	lines.push(`  W 缓存写     ${padLeft(tokens(current.totals.cacheWrite), 12)}  ${padLeft(percent(current.totals.cacheWrite, current.totals.totalTokens), 6)}`);
	lines.push("");

	const byModel = new Map<string, SessionUsage["totals"] & { calls: number; isCodex: boolean }>();
	for (const turn of current.turns) {
		const key = modelName(turn);
		const total = byModel.get(key) ?? { ...emptyTotals(), calls: 0, isCodex: isCodexTurn(turn) };
		addUsage(total, turn);
		total.calls += 1;
		total.isCodex ||= isCodexTurn(turn);
		byModel.set(key, total);
	}
	if (byModel.size > 0) {
		lines.push("按模型汇总");
		lines.push("  Calls    Tokens      Cost   Model");
		for (const [name, total] of [...byModel].sort((a, b) => b[1].totalTokens - a[1].totalTokens)) {
			lines.push(`  ${padLeft(String(total.calls), 5)}  ${padLeft(compactTokens(total.totalTokens), 8)}  ${padLeft(money(total.cost), 10)}  ${total.isCodex ? "[Codex] " : ""}${name}`);
		}
		lines.push("");
	}

	const byRound = new Map<number, SessionUsage["totals"] & { calls: number }>();
	for (const turn of current.turns) {
		const total = byRound.get(turn.userRound) ?? { ...emptyTotals(), calls: 0 };
		addUsage(total, turn);
		total.calls += 1;
		byRound.set(turn.userRound, total);
	}
	if (byRound.size > 0) {
		lines.push("");
		lines.push("按用户对话轮次汇总");
		lines.push("  轮次  Calls    Tokens      Cost");
		for (const [round, total] of byRound) {
			lines.push(`  ${padLeft(String(round), 4)}  ${padLeft(String(total.calls), 5)}  ${padLeft(compactTokens(total.totalTokens), 8)}  ${padLeft(money(total.cost), 10)}`);
		}
	}

	lines.push("");
	lines.push("模型调用按 Session 聚合（默认折叠，↑↓ 选择，Enter/Space 展开）");
	lines.push("  展开后可查看该 session 内每次模型调用的 token、成本、模型和缓存数据");

	const groupedSessions = mode === "all"
		? [...sessions].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
		: [current];
	const groups: SessionGroup[] = groupedSessions.map((s, index) => ({
		id: s.sessionFile,
		title: `${bar(s.totals.totalTokens, maxSessionTokens)}  ${shortSessionName(s.sessionFile)}`,
		session: s,
		maxTurnTokens: Math.max(0, ...s.turns.map((t) => t.totalTokens)),
	}));

	return {
		lines,
		groups,
		footer: ["", `当前会话文件: ${current.sessionFile}`, `数据文件: ${STORE_FILE}`],
	};
}

async function showReport(report: Report, ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui") {
		const expanded = new Set(report.groups.map((g) => g.id));
		const groupLines = report.groups.flatMap((group) => renderSessionGroup(group, expanded.has(group.id), false));
		console.log([...report.lines, ...groupLines, ...report.footer].join("\n"));
		return;
	}

	let selectedIndex = 0;
	const expanded = new Set<string>();

	await ctx.ui.custom((_tui, theme, _kb, done) => ({
		invalidate() {},
		render(width: number): string[] {
			const groupLines = report.groups.flatMap((group, index) => renderSessionGroup(group, expanded.has(group.id), index === selectedIndex));
			const allLines = [...report.lines, ...groupLines, ...report.footer];
			return allLines.map((line, i) => {
				let colored = line;
				const isHeading = ["Codex 额度消耗百分比", "当前会话 token 构成", "按模型汇总", "模型调用按 Session 聚合（默认折叠，↑↓ 选择，Enter/Space 展开）", "按用户对话轮次汇总"].includes(line);
				if (i === 0) colored = theme.fg("accent", theme.bold(line));
				else if (line.startsWith("━")) colored = theme.fg("borderMuted", line);
				else if (isHeading) colored = theme.fg("accent", theme.bold(line));
				else if (line.includes("用量条") || line.includes("Calls") || line.includes("展开后")) colored = theme.fg("muted", line);
				else if (line.startsWith("›")) colored = theme.fg("accent", line);
				else if (line.startsWith("当前会话文件:") || line.startsWith("数据文件:")) colored = theme.fg("dim", line);
				return visibleWidth(colored) <= width ? colored : truncateToWidth(colored, width, theme.fg("dim", "…"));
			}).concat(["", theme.fg("dim", "↑/↓ 选择 session，Enter/Space 展开/折叠，Esc 关闭")]);
		},
		handleInput(data: string) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				done(undefined);
				return;
			}
			if (matchesKey(data, "up")) {
				selectedIndex = Math.max(0, selectedIndex - 1);
				return;
			}
			if (matchesKey(data, "down")) {
				selectedIndex = Math.min(Math.max(0, report.groups.length - 1), selectedIndex + 1);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space") || data === " ") {
				const group = report.groups[selectedIndex];
				if (!group) return;
				if (expanded.has(group.id)) expanded.delete(group.id);
				else expanded.add(group.id);
			}
		},
	}));
}

export default function (pi: ExtensionAPI) {
	function refreshStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const snapshot = saveSnapshot(ctx);
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `usage ${money(snapshot.totals.cost)} · ${tokens(snapshot.totals.totalTokens)} tok`));
	}

	pi.on("session_start", async (_event, ctx) => refreshStatus(ctx));
	pi.on("message_end", async (event, ctx) => {
		if ((event as any).message?.role === "assistant") refreshStatus(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => refreshStatus(ctx));
	pi.on("agent_end", async (_event, ctx) => refreshStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshStatus(ctx));
	pi.on("session_compact", async (_event, ctx) => refreshStatus(ctx));

	const usageCommand = async (args: string | undefined, ctx: ExtensionCommandContext) => {
		const rawArgs = (args ?? "").trim();
		const lowerArgs = rawArgs.toLowerCase();
		if (lowerArgs.startsWith("quota")) {
			const fiveHourTokens = parseQuota(rawArgs.match(/(?:5h|fiveHour|five-hour)\s*=\s*([^\s]+)/i)?.[1]);
			const weeklyTokens = parseQuota(rawArgs.match(/(?:week|weekly|7d)\s*=\s*([^\s]+)/i)?.[1]);
			if (!fiveHourTokens && !weeklyTokens) {
				ctx.ui.notify("用法: /usage quota 5h=150 week=1000（仅 Codex 调用次数额度）", "warning");
				return;
			}
			saveQuota({ fiveHourTokens, weeklyTokens });
			ctx.ui.notify(`Codex 调用次数额度已更新: 5h=${fiveHourTokens ? fiveHourTokens.toLocaleString() : "不变"}, week=${weeklyTokens ? weeklyTokens.toLocaleString() : "不变"}`, "info");
			return;
		}

		const mode = lowerArgs === "all" ? "all" : "current";
		const current = saveSnapshot(ctx);
		const store = loadStore();
		const report = buildReport(current, store, mode);
		await showReport(report, ctx);
	};

	pi.registerCommand("usage", {
		description: "查看所有模型的成本和 token 用量；Codex 会按调用次数额外显示 5h/周额度占比。用法: /usage [all] 或 /usage quota 5h=150 week=1000",
		handler: usageCommand,
	});
}
