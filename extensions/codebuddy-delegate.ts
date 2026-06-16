import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	keyHint,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MODES = ["review", "plan", "debug", "test", "implement"] as const;
const PERMISSION_MODES = ["default", "sandbox", "autoApprove"] as const;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

// jiti runs this CommonJS-flavoured extension in pi. Keep require optional for ESM tests.
declare const require: ((id: string) => any) | undefined;

function stringEnum<T extends readonly string[]>(values: T, description: string) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, description });
}

type CodeBuddyMode = (typeof MODES)[number];
type PermissionMode = (typeof PERMISSION_MODES)[number];
type RunnerKind = "pty" | "exec";
type StreamUpdate = (text: string, details?: Record<string, unknown>) => void;

interface CommandSpec {
	exe: string;
	argsPrefix: string[];
}

const CodeBuddyDelegateParams = Type.Object({
	task: Type.String({ description: "Task to delegate to CodeBuddy CLI (codebuddy)." }),
	mode: Type.Optional(stringEnum(MODES, "Delegation mode. Default: review.")),
	addDirs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Workspace directories passed as repeated codebuddy --add-dir arguments. Default: ['.'].",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "Process timeout in seconds. Clamped to 1..1800. Default: 30." }),
	),
	timeoutMinutes: Type.Optional(
		Type.Number({ description: "Deprecated: process timeout in minutes. Use timeoutSeconds instead." }),
	),
	model: Type.Optional(Type.String({ description: "Optional CodeBuddy model ID passed via --model." })),
	permissionMode: Type.Optional(
		stringEnum(PERMISSION_MODES, "CodeBuddy permission mode: default, sandbox, or autoApprove. Default: default."),
	),
	allowWrites: Type.Optional(
		Type.Boolean({
			description:
				"Allow CodeBuddy to modify files. Default: false. autoApprove additionally requires interactive user confirmation.",
		}),
	),
});

interface CodeBuddyDelegateDetails {
	mode: CodeBuddyMode;
	addDirs: string[];
	timeoutSeconds: number;
	permissionMode: PermissionMode;
	allowWrites: boolean;
	model?: string;
	runner: RunnerKind;
	command: string[];
	exitCode: number | null;
	killed?: boolean;
	durationMs: number;
	truncation?: TruncationResult;
}

interface CodeBuddyRunResult {
	runner: RunnerKind;
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	rawOutput?: string;
	captureTruncated?: boolean;
}

function clampTimeoutSeconds(secondsValue: unknown, minutesValue: unknown): number {
	if (typeof secondsValue === "number" && Number.isFinite(secondsValue)) {
		return Math.max(1, Math.min(1800, Math.ceil(secondsValue)));
	}
	if (typeof minutesValue === "number" && Number.isFinite(minutesValue)) {
		return Math.max(1, Math.min(1800, Math.ceil(minutesValue * 60)));
	}
	return 30;
}

function sanitizeAddDirs(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) return ["."];
	const dirs = value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim())
		.slice(0, 10);
	return dirs.length > 0 ? dirs : ["."];
}

function shellDisplay(args: string[]): string {
	return args
		.map((arg) => {
			if (/^[A-Za-z0-9_./:=+\\-]+$/.test(arg)) return arg;
			return JSON.stringify(arg);
		})
		.join(" ");
}

function buildArgs(options: {
	addDirs: string[];
	model?: string;
	permissionMode: PermissionMode;
	allowWrites: boolean;
	prompt: string;
}): string[] {
	const args: string[] = [];
	if (options.model?.trim()) args.push("--model", options.model.trim());
	for (const dir of options.addDirs) args.push("--add-dir", dir);

	if (options.permissionMode === "sandbox") {
		args.push("--sandbox", "container");
	} else if (options.permissionMode === "autoApprove") {
		args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
	} else if (!options.allowWrites) {
		args.push("--permission-mode", "plan");
	}

	args.push("--print", options.prompt);
	return args;
}

function redactPrompt(command: string[], prompt: string): string[] {
	return command.map((arg) => (arg === prompt ? "<prompt>" : arg));
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 1) return "…";
	const head = Math.ceil((maxChars - 1) / 2);
	const tail = Math.floor((maxChars - 1) / 2);
	return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function loadNodePty(): any | undefined {
	if (typeof require !== "function") return undefined;
	try {
		return require("node-pty");
	} catch {
		try {
			return require("./node_modules/node-pty");
		} catch {
			return undefined;
		}
	}
}

function findCodeBuddyCommand(): CommandSpec {
	const explicit = process.env.CODEBUDDY_PATH?.trim();
	if (explicit) return { exe: explicit, argsPrefix: [] };

	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		if (appData) {
			const script = join(appData, "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
			if (existsSync(script)) return { exe: process.execPath, argsPrefix: [script] };
		}
	}

	return { exe: "codebuddy", argsPrefix: [] };
}

function stripTerminalOutput(raw: string): string {
	let text = raw;
	text = text.replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "");
	text = text.replace(/\x1B[P^_X][\s\S]*?\x1B\\/g, "");
	text = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
	text = text.replace(/\x1B[@-Z\\-_]/g, "");
	text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/^\s+/, "")
		.replace(/\s+$/, "");
}

function createThrottledStream(onOutput?: StreamUpdate, intervalMs = 250): StreamUpdate {
	if (!onOutput) return () => {};

	let latestText = "";
	let latestDetails: Record<string, unknown> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		timer = undefined;
		onOutput(latestText, latestDetails);
	};

	const update: StreamUpdate = (text, details) => {
		latestText = text;
		latestDetails = details;
		if (!timer) timer = setTimeout(flush, intervalMs);
	};

	(update as StreamUpdate & { flush?: () => void }).flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		onOutput(latestText, latestDetails);
	};

	return update;
}

function flushStream(update: StreamUpdate) {
	(update as StreamUpdate & { flush?: () => void }).flush?.();
}

function trimCapturedText(text: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= MAX_CAPTURE_BYTES) return { text, truncated: false };
	return { text: text.slice(Math.floor(text.length / 2)), truncated: true };
}

async function runCodeBuddyWithPty(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onOutput?: StreamUpdate,
): Promise<CodeBuddyRunResult | undefined> {
	const pty = loadNodePty();
	if (!pty?.spawn) return undefined;

	return new Promise((resolve) => {
		const command = findCodeBuddyCommand();
		let raw = "";
		let captureTruncated = false;
		let settled = false;
		let killed = false;
		let term: any;
		const stream = createThrottledStream(onOutput);

		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", kill);
			const clean = stripTerminalOutput(raw);
			stream(clean, { runner: "pty", exitCode: code, done: true, captureTruncated });
			flushStream(stream);
			resolve({ runner: "pty", stdout: clean, stderr: "", code, killed, rawOutput: raw, captureTruncated });
		};

		const kill = () => {
			killed = true;
			try {
				term?.kill();
			} catch {
				// Ignore kill errors; the exit handler or timeout fallback will settle.
			}
		};

		const timer = setTimeout(() => {
			kill();
			setTimeout(() => settle(124), 2000);
		}, timeoutMs);

		try {
			term = pty.spawn(command.exe, [...command.argsPrefix, ...args], {
				name: "xterm-256color",
				cols: 160,
				rows: 50,
				cwd,
				env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1", FORCE_COLOR: "0" },
			});
		} catch (error) {
			clearTimeout(timer);
			const message = error instanceof Error ? error.message : String(error);
			resolve({ runner: "pty", stdout: "", stderr: `Failed to spawn codebuddy via PTY: ${message}`, code: 1, killed: false });
			return;
		}

		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}

		term.onData((chunk: string) => {
			raw += chunk;
			const trimmed = trimCapturedText(raw);
			if (trimmed.truncated) {
				captureTruncated = true;
				raw = trimmed.text;
			}
			stream(stripTerminalOutput(raw), { runner: "pty", captureTruncated });
		});

		term.onExit((event: { exitCode?: number }) => {
			settle(event.exitCode ?? (killed ? 124 : 1));
		});
	});
}

async function runCodeBuddyWithSpawn(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onOutput?: StreamUpdate,
): Promise<CodeBuddyRunResult> {
	return new Promise((resolve) => {
		const command = findCodeBuddyCommand();
		let stdout = "";
		let stderr = "";
		let captureTruncated = false;
		let settled = false;
		let killed = false;
		const stream = createThrottledStream(onOutput);

		const renderCombined = () => [stdout.trimEnd(), stderr.trimEnd() ? `\n\n[stderr]\n${stderr.trimEnd()}` : ""].join("").trim();

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command.exe, [...command.argsPrefix, ...args], {
				cwd,
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
				windowsHide: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			resolve({ runner: "exec", stdout: "", stderr: `Failed to spawn codebuddy: ${message}`, code: 1, killed: false });
			return;
		}

		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", kill);
			stream(renderCombined(), { runner: "exec", exitCode: code, done: true, captureTruncated });
			flushStream(stream);
			resolve({ runner: "exec", stdout, stderr, code, killed, captureTruncated });
		};

		const kill = () => {
			killed = true;
			try {
				child.kill();
			} catch {
				// Ignore kill errors; close/error handlers settle the result.
			}
		};

		const timer = setTimeout(() => {
			kill();
			setTimeout(() => settle(124), 2000);
		}, timeoutMs);

		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
			const trimmed = trimCapturedText(stdout);
			if (trimmed.truncated) {
				captureTruncated = true;
				stdout = trimmed.text;
			}
			stream(renderCombined(), { runner: "exec", captureTruncated });
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
			const trimmed = trimCapturedText(stderr);
			if (trimmed.truncated) {
				captureTruncated = true;
				stderr = trimmed.text;
			}
			stream(renderCombined(), { runner: "exec", captureTruncated });
		});

		child.on("error", (error) => {
			stderr += `Failed to spawn codebuddy: ${error instanceof Error ? error.message : String(error)}`;
			settle(1);
		});

		child.on("close", (code) => {
			settle(code ?? (killed ? 124 : 1));
		});
	});
}

async function runCodeBuddy(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onOutput?: StreamUpdate,
): Promise<CodeBuddyRunResult> {
	// Prefer a pseudo-terminal so CodeBuddy can render interactive-style progress while --print runs.
	const ptyResult = await runCodeBuddyWithPty(args, cwd, timeoutMs, signal, onOutput);
	if (ptyResult) return ptyResult;

	return runCodeBuddyWithSpawn(args, cwd, timeoutMs, signal, onOutput);
}

function formatLiveOutput(input: {
	runner?: RunnerKind;
	exitCode?: number;
	durationMs?: number;
	captureTruncated?: boolean;
	command: string[];
	body: string;
}): string {
	const header = [
		`# codebuddy_delegate streaming`,
		input.runner ? `- runner: ${input.runner}` : undefined,
		input.exitCode !== undefined ? `- exitCode: ${input.exitCode}` : undefined,
		input.durationMs !== undefined ? `- durationMs: ${input.durationMs}` : undefined,
		input.captureTruncated ? `- captureTruncated: true` : undefined,
		`- command: ${shellDisplay(input.command)}`,
	]
		.filter(Boolean)
		.join("\n");

	return `${header}\n\n## Output\n\n${input.body || "(waiting for codebuddy output...)"}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "codebuddy_delegate",
		label: "codebuddy delegate",
		description:
			"Delegate a task to the local CodeBuddy CLI (codebuddy). Best for web search/research, second-opinion review, planning, debugging analysis, and test suggestions. Uses a PTY runner when available and streams output into pi; final output is included/truncated in the tool result and no report files are written.",
		promptSnippet: "Delegate web search/research, analysis, planning, debugging, test design, or review work to the local CodeBuddy CLI (codebuddy).",
		promptGuidelines: [
			"Use codebuddy_delegate when the user explicitly asks to use CodeBuddy, or when an independent second opinion would help on complex review, planning, debugging, refactoring risk analysis, or test design.",
			"Use codebuddy_delegate for broad repository exploration, cross-file flow tracing, or implementation planning when a separate CodeBuddy pass would be useful.",
			"When using codebuddy_delegate for search/research, pass the user's request directly in task, ask CodeBuddy to search/gather sources as needed, and keep allowWrites=false with permissionMode='default'.",
			"Do not use codebuddy_delegate for trivial edits, simple file lookups, short direct answers, or tasks that pi can complete immediately without broad exploration.",
			"Use codebuddy_delegate in read-only mode by default: allowWrites=false with permissionMode='default' maps to CodeBuddy plan mode. Pi remains responsible for final code edits, verification, and user-facing conclusions.",
		],
		parameters: CodeBuddyDelegateParams,

		renderCall(args, theme, context) {
			const task = typeof args.task === "string" ? args.task : "";
			const mode = typeof args.mode === "string" ? args.mode : "review";
			const addDirs = Array.isArray(args.addDirs) && args.addDirs.length > 0 ? args.addDirs.join(", ") : ".";
			const title = theme.fg("toolTitle", theme.bold("codebuddy delegate "));
			let text = `${title}${theme.fg("accent", mode)} ${theme.fg("dim", `[${addDirs}]`)}`;

			if (!task) return new Text(text, 0, 0);

			if (context.expanded) {
				text += `\n${theme.fg("muted", "prompt:")}`;
				text += `\n${theme.fg("toolOutput", task)}`;
			} else {
				const preview = truncateMiddle(collapseWhitespace(task), 140);
				text += ` ${theme.fg("dim", JSON.stringify(preview))}`;
				text += ` ${theme.fg("muted", `(${keyHint("app.tools.expand", "full prompt")})`)}`;
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const content = result.content.find((item) => item.type === "text");
			if (!content || content.type !== "text") return new Text("", 0, 0);

			let text = content.text;
			const task = typeof context.args?.task === "string" ? context.args.task : "";
			if (expanded && task) {
				text += `\n\n## Full codebuddy prompt\n\n${task}`;
			}

			return new Text(theme.fg("toolOutput", text), 0, 0);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task.trim();
			if (!task) throw new Error("codebuddy_delegate requires a non-empty task.");

			const mode = (params.mode ?? "review") as CodeBuddyMode;
			const addDirs = sanitizeAddDirs(params.addDirs);
			const timeoutSeconds = clampTimeoutSeconds(params.timeoutSeconds, params.timeoutMinutes);
			const permissionMode = (params.permissionMode ?? "default") as PermissionMode;
			const allowWrites = params.allowWrites === true;
			const model = params.model?.trim() || undefined;

			if (permissionMode === "autoApprove") {
				if (!allowWrites) {
					throw new Error("permissionMode='autoApprove' requires allowWrites=true. Use sandbox/default for read-only delegation.");
				}
				if (!ctx.hasUI) {
					throw new Error("permissionMode='autoApprove' requires interactive user confirmation, but no UI is available.");
				}
				const ok = await ctx.ui.confirm(
					"Allow codebuddy auto-approve?",
					"codebuddy_delegate was asked to run codebuddy with --dangerously-skip-permissions and allowWrites=true. This may modify files without further permission prompts. Continue?",
					{ timeout: 15000 },
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "codebuddy_delegate cancelled: user did not approve auto-approve write mode." }],
						details: {
							mode,
							addDirs,
							timeoutSeconds,
							permissionMode,
							allowWrites,
							model,
							runner: "pty",
							command: [],
							exitCode: null,
							durationMs: 0,
						} satisfies CodeBuddyDelegateDetails,
					};
				}
			}

			const prompt = task;
			const command = buildArgs({ addDirs, model, permissionMode, allowWrites, prompt });
			const redactedCommand = redactPrompt(command, prompt);
			const displayCommand = ["codebuddy", ...redactedCommand];
			const start = Date.now();
			let lastStreamText = "";
			const emitUpdate = (body: string, details?: Record<string, unknown>) => {
				lastStreamText = body;
				const liveMarkdown = formatLiveOutput({
					runner: details?.runner as RunnerKind | undefined,
					exitCode: details?.exitCode as number | undefined,
					durationMs: Date.now() - start,
					captureTruncated: details?.captureTruncated === true,
					command: displayCommand,
					body,
				});
				const liveTruncation = truncateHead(liveMarkdown, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				onUpdate?.({
					content: [{ type: "text", text: liveTruncation.content }],
					details: { ...details, streaming: true, truncation: liveTruncation.truncated ? liveTruncation : undefined },
				});
			};

			emitUpdate("(starting codebuddy...)");
			const result = await runCodeBuddy(command, ctx.cwd, timeoutSeconds * 1000 + 30_000, signal, emitUpdate);
			const durationMs = Date.now() - start;
			const stdout = result.stdout ?? "";
			const stderr = result.stderr ?? "";
			const combined = [stdout.trimEnd(), stderr.trimEnd() ? `\n\n[stderr]\n${stderr.trimEnd()}` : ""].join("").trim();

			const body = combined || lastStreamText || "(codebuddy produced no stdout/stderr. If runner=exec, install node-pty or run /reload after installing it.)";
			const resultMarkdown = formatLiveOutput({
				runner: result.runner,
				exitCode: result.code,
				durationMs,
				captureTruncated: result.captureTruncated,
				command: displayCommand,
				body,
			}).replace("# codebuddy_delegate streaming", "# codebuddy_delegate result");

			const truncation = truncateHead(resultMarkdown, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
					truncation.outputBytes,
				)} of ${formatSize(truncation.totalBytes)}).]`;
			}

			const details: CodeBuddyDelegateDetails = {
				mode,
				addDirs,
				timeoutSeconds,
				permissionMode,
				allowWrites,
				model,
				runner: result.runner,
				command: displayCommand,
				exitCode: result.code,
				killed: result.killed,
				durationMs,
				truncation: truncation.truncated ? truncation : undefined,
			};

			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	});
}
