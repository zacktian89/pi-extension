import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 120_000;

function runCodeGraph(args: string[], ctx: ExtensionContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("codegraph", args, {
			cwd: ctx.cwd,
			shell: true,
			windowsHide: true,
			env: { ...process.env, NO_COLOR: "1" },
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (err?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(output ?? "");
		};

		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`codegraph ${args.join(" ")} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > MAX_OUTPUT_CHARS) stdout = stdout.slice(-MAX_OUTPUT_CHARS);
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			if (stderr.length > MAX_OUTPUT_CHARS) stderr = stderr.slice(-MAX_OUTPUT_CHARS);
		});

		child.on("error", (err) => finish(err));
		child.on("close", (code) => {
			const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n[stderr]\n");
			if (code === 0) finish(undefined, output || "(no output)");
			else finish(new Error(`codegraph exited with code ${code}\n${output}`));
		});
	});
}

function toolResult(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export default function codegraphExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codegraph_status",
		label: "CodeGraph Status",
		description: "Show CodeGraph index health and statistics for the current project.",
		promptSnippet: "Check CodeGraph index health for the current project.",
		promptGuidelines: ["Use codegraph_status before CodeGraph queries if you are unsure whether the current project is indexed."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const text = await runCodeGraph(["status"], ctx);
			return toolResult(text, { command: "codegraph status", cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_query",
		label: "CodeGraph Query",
		description: "Search indexed symbols by name or phrase using CodeGraph.",
		promptSnippet: "Search indexed code symbols with CodeGraph.",
		promptGuidelines: ["Use codegraph_query for where-is-X or symbol lookup questions before grep/read."],
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name or search phrase." }),
			kind: Type.Optional(Type.String({ description: "Optional symbol kind filter, e.g. function, class, method, file." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["query", params.query];
			if (params.kind) args.push("--kind", params.kind);
			if (params.limit) args.push("--limit", String(params.limit));
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description: "Explore an area of the codebase: relevant symbols' source plus relationship map in one call.",
		promptSnippet: "Explore related code with source snippets and relationships via CodeGraph.",
		promptGuidelines: ["Use codegraph_explore for architecture, flow-tracing, and how-does-X-work questions before reading many files."],
		parameters: Type.Object({
			query: Type.String({ description: "Natural language or symbol-focused exploration query." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["explore", params.query];
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_node",
		label: "CodeGraph Node",
		description: "Get one symbol's source plus caller/callee trail, or inspect a file with line numbers and dependents.",
		promptSnippet: "Fetch one indexed symbol or file detail from CodeGraph.",
		promptGuidelines: ["Use codegraph_node when you need details for a known symbol or file before raw read."],
		parameters: Type.Object({
			name: Type.String({ description: "Symbol name or file path." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["node", params.name];
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_callers",
		label: "CodeGraph Callers",
		description: "Find functions or methods that call a symbol.",
		promptSnippet: "Find callers of an indexed symbol via CodeGraph.",
		promptGuidelines: ["Use codegraph_callers for caller analysis before grep."],
		parameters: Type.Object({ symbol: Type.String({ description: "Function, method, or symbol name." }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["callers", params.symbol];
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_callees",
		label: "CodeGraph Callees",
		description: "Find functions or methods called by a symbol.",
		promptSnippet: "Find callees of an indexed symbol via CodeGraph.",
		promptGuidelines: ["Use codegraph_callees for callee analysis before grep."],
		parameters: Type.Object({ symbol: Type.String({ description: "Function, method, or symbol name." }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["callees", params.symbol];
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_impact",
		label: "CodeGraph Impact",
		description: "Analyze what code is affected by changing a symbol.",
		promptSnippet: "Analyze change impact for a symbol via CodeGraph.",
		promptGuidelines: ["Use codegraph_impact for refactor/change-risk questions before scanning files manually."],
		parameters: Type.Object({
			symbol: Type.String({ description: "Symbol to analyze." }),
			depth: Type.Optional(Type.Number({ description: "Optional graph traversal depth." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["impact", params.symbol];
			if (params.depth) args.push("--depth", String(params.depth));
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "codegraph_files",
		label: "CodeGraph Files",
		description: "Show indexed project file structure faster than filesystem scanning.",
		promptSnippet: "List indexed file structure from CodeGraph.",
		promptGuidelines: ["Use codegraph_files when you need a high-level file map of an indexed project."],
		parameters: Type.Object({
			filter: Type.Optional(Type.String({ description: "Optional file path/name filter." })),
			maxDepth: Type.Optional(Type.Number({ description: "Optional max directory depth." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = ["files"];
			if (params.filter) args.push("--filter", params.filter);
			if (params.maxDepth) args.push("--max-depth", String(params.maxDepth));
			const text = await runCodeGraph(args, ctx);
			return toolResult(text, { command: `codegraph ${args.join(" ")}`, cwd: ctx.cwd });
		},
	});

	pi.registerCommand("codegraph-sync", {
		description: "Run CodeGraph incremental sync for the current project.",
		handler: async (_args, ctx) => {
			try {
				const text = await runCodeGraph(["sync"], ctx, 120_000);
				ctx.ui.notify(`CodeGraph sync complete\n${text.slice(0, 600)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("CodeGraph tools loaded for pi: codegraph_query/explore/node/callers/callees/impact/files/status", "info");
	});
}
