import type { ExtensionAPI, ExtensionContext, ContextUsage } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Segment = {
	label: string;
	tokens: number;
	color: number;
};

const WIDGET_ID = "context-growth";
const STATUS_ID = "context-growth";
const BAR_WIDTH = 36;
const COLORS = [196, 202, 208, 220, 118, 48, 51, 45, 33, 99, 129, 165, 201, 207, 213];
const BASE_COLOR = 93;
const EMPTY_COLOR = 236;

function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return `${(n / 1000000).toFixed(n < 10000000 ? 1 : 0)}M`;
}

function fg256(color: number, text: string): string {
	return `\x1b[1;38;5;${color}m${text}\x1b[0m`;
}

function bg256(color: number, text: string): string {
	return `\x1b[48;5;${color}m${text}\x1b[0m`;
}

function pct(tokens: number | null, window: number): string {
	if (tokens === null || !window) return "?";
	return `${((tokens / window) * 100).toFixed(1)}%`;
}

function renderStackedBar(baseTokens: number, segments: Segment[], usage: ContextUsage | undefined): string {
	const contextWindow = usage?.contextWindow ?? 0;
	const currentTokens = usage?.tokens ?? null;
	if (!contextWindow || currentTokens === null) return "[context unknown]";

	const used = Math.max(0, Math.min(contextWindow, currentTokens));
	const usedCells = Math.max(0, Math.min(BAR_WIDTH, Math.round((used / contextWindow) * BAR_WIDTH)));
	if (usedCells === 0) return `[${bg256(EMPTY_COLOR, " ".repeat(BAR_WIDTH))}]`;

	// Allocate visible cells across the baseline and each growth segment.
	// Small per-turn growth can be < 1 bar cell; give every non-zero round at least
	// one colored cell when possible so the bar itself shows the growth history.
	const parts = [
		{ tokens: Math.max(0, baseTokens), color: BASE_COLOR },
		...segments.map((s) => ({ tokens: Math.max(0, s.tokens), color: s.color })),
	].filter((p) => p.tokens > 0);

	const totalPartTokens = parts.reduce((sum, p) => sum + p.tokens, 0);
	const raw = parts.map((p) => (totalPartTokens ? (p.tokens / totalPartTokens) * usedCells : 0));
	const cellsForParts = raw.map((v) => Math.floor(v));

	let allocated = cellsForParts.reduce((sum, n) => sum + n, 0);
	const nonZeroGrowthIndexes = parts
		.map((p, i) => ({ p, i }))
		.filter(({ p, i }) => i > 0 && p.tokens > 0 && cellsForParts[i] === 0)
		.map(({ i }) => i);

	for (const i of nonZeroGrowthIndexes) {
		if (allocated >= usedCells) break;
		cellsForParts[i] = 1;
		allocated += 1;
	}

	while (allocated > usedCells) {
		let donor = cellsForParts.findIndex((n, i) => i === 0 && n > 0);
		if (donor < 0) donor = cellsForParts.findIndex((n) => n > 1);
		if (donor < 0) break;
		cellsForParts[donor] -= 1;
		allocated -= 1;
	}

	while (allocated < usedCells) {
		let best = 0;
		let bestRemainder = -1;
		for (let i = 0; i < raw.length; i++) {
			const remainder = raw[i]! - Math.floor(raw[i]!);
			if (remainder > bestRemainder) {
				best = i;
				bestRemainder = remainder;
			}
		}
		cellsForParts[best] = (cellsForParts[best] ?? 0) + 1;
		allocated += 1;
	}

	let cells = "";
	for (let i = 0; i < parts.length; i++) {
		const count = cellsForParts[i] ?? 0;
		if (count <= 0) continue;
		cells += bg256(parts[i]!.color, " ".repeat(count));
	}
	if (usedCells < BAR_WIDTH) cells += bg256(EMPTY_COLOR, " ".repeat(BAR_WIDTH - usedCells));
	return `[${cells}]`;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let baseTokens = 0;
	let lastTokens: number | null = null;
	let usage: ContextUsage | undefined;
	let segments: Segment[] = [];
	let sampleNo = 0;

	function reset(ctx: ExtensionContext) {
		usage = ctx.getContextUsage();
		baseTokens = usage?.tokens ?? 0;
		lastTokens = usage?.tokens ?? null;
		segments = [];
		sampleNo = 0;
	}

	function installWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}

		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const tokens = usage?.tokens ?? null;
					const remaining = tokens === null ? null : Math.max(0, window - tokens);
					const title = theme.fg("accent", "Context") + theme.fg("dim", ` used ${pct(tokens, window)} • left ${remaining === null ? "?" : fmtTokens(remaining)}/${fmtTokens(window)}`);
					const bar = renderStackedBar(baseTokens, segments, usage);
					const recent = segments
						.slice(-6)
						.map((s) => `${fg256(s.color, "■")} ${s.label}+${fmtTokens(s.tokens)}`)
						.join(theme.fg("dim", "  "));
					const lines = [title, bar];
					if (recent) lines.push(theme.fg("dim", "Rounds: ") + recent);
					return lines.map((line) => {
						if (visibleWidth(line) <= width) return line;
						return truncateToWidth(line, width, theme.fg("dim", "…"));
					});
				},
			}),
		);

		const tokens = usage?.tokens ?? null;
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `ctx ${pct(tokens, window)}`));
	}

	function record(ctx: ExtensionContext, labelPrefix = "R") {
		const nextUsage = ctx.getContextUsage();
		usage = nextUsage ?? usage;
		const tokens = nextUsage?.tokens ?? null;
		if (tokens !== null) {
			if (lastTokens === null) {
				lastTokens = tokens;
				baseTokens = tokens;
			} else if (tokens < lastTokens) {
				// Compaction/tree navigation can shrink context; start a new baseline.
				baseTokens = tokens;
				segments = [];
				sampleNo = 0;
				lastTokens = tokens;
			} else if (tokens > lastTokens) {
				sampleNo += 1;
				segments.push({
					label: `${labelPrefix}${sampleNo}`,
					tokens: tokens - lastTokens,
					color: COLORS[(sampleNo - 1) % COLORS.length]!,
				});
				lastTokens = tokens;
			}
		}
		installWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx);
		installWidget(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		// In recent pi versions the core context snapshot is refreshed when the
		// assistant message is committed.  turn_end can fire before that happens,
		// which left the widget installed but stuck at the startup baseline.
		if ((event as any).message?.role === "assistant") record(ctx, "M");
	});

	pi.on("turn_end", async (_event, ctx) => {
		record(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Fallback for providers/event paths that only expose final usage after
		// the whole agent run has completed. Duplicate samples are ignored because
		// record() only appends when token count increases.
		record(ctx, "A");
	});

	pi.on("session_tree", async (_event, ctx) => {
		// /tree changes the active branch. Treat the new branch as a fresh baseline.
		reset(ctx);
		installWidget(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		reset(ctx);
		installWidget(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		usage = ctx.getContextUsage();
		installWidget(ctx);
	});

	pi.registerCommand("context-growth", {
		description: "Toggle the colored context growth progress bar",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase();
			if (action === "reset") {
				reset(ctx);
				enabled = true;
			} else if (action === "off" || action === "disable") {
				enabled = false;
			} else if (action === "on" || action === "enable") {
				enabled = true;
			} else {
				enabled = !enabled;
			}
			installWidget(ctx);
			ctx.ui.notify(`Context growth ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
