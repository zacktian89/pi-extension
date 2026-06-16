import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

type AgyMode = (typeof MODES)[number];
type PermissionMode = (typeof PERMISSION_MODES)[number];
type RunnerKind = "pty" | "exec" | "detached";
type StreamUpdate = (text: string, details?: Record<string, unknown>) => void;

const AgyDelegateParams = Type.Object({
	task: Type.String({ description: "Task to delegate to Antigravity CLI (agy)." }),
	mode: Type.Optional(stringEnum(MODES, "Delegation mode. Default: review.")),
	addDirs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Workspace directories passed as repeated agy --add-dir arguments. Default: ['.'].",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "agy --print-timeout in seconds. Clamped to 1..1800. Default: 30." }),
	),
	timeoutMinutes: Type.Optional(
		Type.Number({ description: "Deprecated: agy --print-timeout in minutes. Use timeoutSeconds instead." }),
	),
	model: Type.Optional(Type.String({ description: "Optional agy model name passed via --model." })),
	permissionMode: Type.Optional(
		stringEnum(PERMISSION_MODES, "agy permission mode: default, sandbox, or autoApprove. Default: default."),
	),
	allowWrites: Type.Optional(
		Type.Boolean({
			description:
				"Allow agy to modify files. Default: false. autoApprove additionally requires interactive user confirmation.",
		}),
	),
	detachedTerminal: Type.Optional(
		Type.Boolean({
			description:
				"Launch interactive agy in a separate terminal and return only a temporary Markdown report path. Default: false. Keep false for synchronous research so pi waits for agy and can continue from the captured result. Set true only when interactive auth/input is needed or the user explicitly wants a detached terminal.",
		}),
	),
});

interface AgyDelegateDetails {
	mode: AgyMode;
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
	reportFile?: string;
	authRequired?: boolean;
}

interface AgyRunResult {
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

function buildCommonArgs(options: { addDirs: string[]; model?: string; permissionMode: PermissionMode }): string[] {
	const args: string[] = [];
	if (options.model?.trim()) args.push("--model", options.model.trim());
	for (const dir of options.addDirs) args.push("--add-dir", dir);
	if (options.permissionMode === "sandbox") args.push("--sandbox");
	if (options.permissionMode === "autoApprove") args.push("--dangerously-skip-permissions");
	return args;
}

function buildArgs(options: {
	addDirs: string[];
	timeoutSeconds: number;
	model?: string;
	permissionMode: PermissionMode;
	prompt: string;
}): string[] {
	const args = buildCommonArgs(options);
	args.push("--print", options.prompt, "--print-timeout", `${options.timeoutSeconds}s`);
	return args;
}

function buildInteractiveArgs(options: {
	addDirs: string[];
	model?: string;
	permissionMode: PermissionMode;
	prompt: string;
}): string[] {
	const args = buildCommonArgs(options);
	args.push(options.prompt);
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

function createTempReportFile(task: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agy-"));
	const reportFile = join(dir, "agy-report.md");
	writeFileSync(
		reportFile,
		`# agy detached report\n\nStatus: waiting for agy to write the final report.\n\n## Task\n\n${task}\n`,
		"utf8",
	);
	return reportFile;
}

function withReportInstruction(task: string, reportFile: string): string {
	return `${task}\n\n---\nYou are running in a detached terminal launched by pi. The user may interact with you directly in this terminal. When you are done, write a concise final Markdown report to this exact path:\n\n${reportFile}\n\nKeep the report focused on conclusions, decisions, commands/results that matter, and any next steps. Do not include hidden chain-of-thought.`;
}

function launchDetachedTerminal(args: string[], cwd: string): { command: string[]; pid?: number } {
	const exe = findAgyExecutable();
	let command: string[];
	let child: ReturnType<typeof spawn>;

	if (process.platform === "win32") {
		command = ["wt.exe", "new-tab", "--title", "agy delegate", exe, ...args];
		child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore", windowsHide: false });
	} else if (process.platform === "darwin") {
		const script = `cd ${JSON.stringify(cwd)} && ${shellDisplay([exe, ...args])}`;
		command = ["osascript", "-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`];
		child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore" });
	} else {
		command = ["x-terminal-emulator", "-e", shellDisplay([exe, ...args])];
		child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore" });
	}

	child.on("error", () => {
		// Detached launch errors cannot be reported after returning; keep them from crashing pi.
	});
	child.unref();
	return { command, pid: child.pid };
}

function findAgyExecutable(): string {
	const explicit = process.env.AGY_PATH?.trim();
	if (explicit) return explicit;

	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			const candidate = join(localAppData, "agy", "bin", "agy.exe");
			if (existsSync(candidate)) return candidate;
		}
		const userProfile = process.env.USERPROFILE;
		if (userProfile) {
			const candidate = join(userProfile, "AppData", "Local", "agy", "bin", "agy.exe");
			if (existsSync(candidate)) return candidate;
		}
		return "agy.exe";
	}

	return "agy";
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

function detectAuthRequired(output: string): boolean {
	return /Authentication required|Waiting for authentication|authorization code|oauth-callback|authentication timed out/i.test(output);
}

function extractFirstUrl(output: string): string | undefined {
	return output.match(/https?:\/\/\S+/)?.[0];
}

function formatAuthRequiredNote(output: string): string {
	const url = extractFirstUrl(output);
	return [
		"## Authentication required",
		"",
		"agy requested interactive authentication before it could complete the delegated task.",
		url ? `- Login URL: ${url}` : undefined,
		"- Synchronous mode cannot finish until agy is authenticated.",
		"- Complete the login in a terminal/browser, then retry the same agy_delegate call with `detachedTerminal: false`.",
		"- If interactive login is required during the task, run once with `detachedTerminal: true` so the user can complete authentication in the opened terminal; after auth is cached, switch back to synchronous mode.",
	]
		.filter(Boolean)
		.join("\n");
}

async function runAgyWithPty(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onOutput?: StreamUpdate,
): Promise<AgyRunResult | undefined> {
	const pty = loadNodePty();
	if (!pty?.spawn) return undefined;

	return new Promise((resolve) => {
		const exe = findAgyExecutable();
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
			term = pty.spawn(exe, args, {
				name: "xterm-256color",
				cols: 160,
				rows: 50,
				cwd,
				env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1", FORCE_COLOR: "0" },
			});
		} catch (error) {
			clearTimeout(timer);
			const message = error instanceof Error ? error.message : String(error);
			resolve({ runner: "pty", stdout: "", stderr: `Failed to spawn agy via PTY: ${message}`, code: 1, killed: false });
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

async function runAgyWithSpawn(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onOutput?: StreamUpdate,
): Promise<AgyRunResult> {
	return new Promise((resolve) => {
		const exe = findAgyExecutable();
		let stdout = "";
		let stderr = "";
		let captureTruncated = false;
		let settled = false;
		let killed = false;
		const stream = createThrottledStream(onOutput);

		const renderCombined = () => [stdout.trimEnd(), stderr.trimEnd() ? `\n\n[stderr]\n${stderr.trimEnd()}` : ""].join("").trim();

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, args, {
				cwd,
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
				windowsHide: true,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			resolve({ runner: "exec", stdout: "", stderr: `Failed to spawn agy: ${message}`, code: 1, killed: false });
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
			stderr += `Failed to spawn agy: ${error instanceof Error ? error.message : String(error)}`;
			settle(1);
		});

		child.on("close", (code) => {
			settle(code ?? (killed ? 124 : 1));
		});
	});
}

async function runAgy(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	onOutput?: StreamUpdate,
): Promise<AgyRunResult> {
	// Antigravity CLI currently drops --print stdout under non-TTY subprocesses on Windows.
	// Prefer a pseudo-terminal so agy writes the same response it shows in a real terminal.
	const ptyResult = await runAgyWithPty(args, cwd, timeoutMs, signal, onOutput);
	if (ptyResult) return ptyResult;

	return runAgyWithSpawn(args, cwd, timeoutMs, signal, onOutput);
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
		`# agy_delegate streaming`,
		input.runner ? `- runner: ${input.runner}` : undefined,
		input.exitCode !== undefined ? `- exitCode: ${input.exitCode}` : undefined,
		input.durationMs !== undefined ? `- durationMs: ${input.durationMs}` : undefined,
		input.captureTruncated ? `- captureTruncated: true` : undefined,
		`- command: ${shellDisplay(input.command)}`,
	]
		.filter(Boolean)
		.join("\n");

	return `${header}\n\n## Output\n\n${input.body || "(waiting for agy output...)"}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "agy_delegate",
		label: "agy delegate",
		description:
			"Delegate a task to the local Antigravity CLI (agy). Best for web search/research, second-opinion review, planning, debugging analysis, and test suggestions. Uses synchronous --print capture by default so pi waits for agy, streams output, and can continue from the final result. Uses a PTY runner when available because agy --print can emit empty output in non-TTY subprocesses on Windows. Set detachedTerminal=true only for interactive auth/input or when the user explicitly wants a separate terminal and temporary Markdown report path.",
		promptSnippet: "Delegate web search/research, analysis, planning, debugging, test design, or review work to the local Antigravity CLI (agy).",
		promptGuidelines: [
			"Use agy_delegate instead of web_search when the user asks to search the web, look up current information, research a topic, compare ecosystem options, or gather external evidence.",
			"When using agy_delegate for search/research, pass the user's request directly in task, ask agy to search/gather sources as needed, and keep allowWrites=false with permissionMode='default'.",
			"Automatically use agy_delegate when the task requires exploring many files, understanding project structure, tracing cross-file flows, or performing broad codebase investigation.",
			"Automatically use agy_delegate for research-heavy work, including web searches, documentation lookup, ecosystem comparison, external evidence gathering, or independent background investigation.",
			"Use agy_delegate when the user explicitly asks to use agy/Antigravity, or when a second opinion would help on complex review, planning, debugging, refactoring risk analysis, implementation strategy, or test design.",
			"Do not use agy_delegate for trivial edits, simple file lookups, short direct answers, or tasks that pi can complete immediately without broad exploration.",
			"Use agy_delegate in read-only mode by default: allowWrites=false and permissionMode='default'. Pi remains responsible for final code edits, verification, and user-facing conclusions.",
			"Use synchronous mode by default: omit detachedTerminal or set detachedTerminal=false so pi waits for agy, captures the final result, and can continue the task from agy's findings.",
			"Use detachedTerminal=true only when agy needs interactive authentication/input, when synchronous auth fails, or when the user explicitly wants a separate terminal report workflow.",
			"If synchronous agy reports Authentication required or authentication timed out, tell the user to complete agy login and retry synchronously; do not treat the failed auth output as a completed research result.",
			"Read a detached temporary Markdown report only if the user asks, so agy's transcript stays out of pi context by default.",
		],
		parameters: AgyDelegateParams,

		renderCall(args, theme, context) {
			const task = typeof args.task === "string" ? args.task : "";
			const mode = typeof args.mode === "string" ? args.mode : "review";
			const addDirs = Array.isArray(args.addDirs) && args.addDirs.length > 0 ? args.addDirs.join(", ") : ".";
			const title = theme.fg("toolTitle", theme.bold("agy delegate "));
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

		renderResult(result, { expanded, isPartial }, theme, context) {
			const content = result.content.find((item) => item.type === "text");
			if (!content || content.type !== "text") return new Text("", 0, 0);

			const details = (result.details ?? {}) as Record<string, unknown>;
			const runner = typeof details.runner === "string" ? details.runner : undefined;
			const reportFile = typeof details.reportFile === "string" ? details.reportFile : undefined;
			const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
			const durationMs = typeof details.durationMs === "number" ? details.durationMs : undefined;

			if (!expanded) {
				const status = isPartial
					? "running"
					: runner === "detached"
						? "launched"
						: exitCode === undefined
							? "done"
							: `exit ${exitCode}`;
				const parts = [
					theme.fg("toolOutput", `agy ${status}`),
					runner ? theme.fg("dim", `[${runner}]`) : undefined,
					durationMs !== undefined ? theme.fg("dim", `${durationMs}ms`) : undefined,
					reportFile ? theme.fg("dim", `report: ${reportFile}`) : undefined,
					theme.fg("muted", `(${keyHint("app.tools.expand", "show details")})`),
				]
					.filter(Boolean)
					.join(" ");
				return new Text(parts, 0, 0);
			}

			let text = content.text;
			const task = typeof context.args?.task === "string" ? context.args.task : "";
			if (task) {
				text += `\n\n## Full agy prompt\n\n${task}`;
			}

			return new Text(theme.fg("toolOutput", text), 0, 0);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task.trim();
			if (!task) throw new Error("agy_delegate requires a non-empty task.");

			const mode = (params.mode ?? "review") as AgyMode;
			const addDirs = sanitizeAddDirs(params.addDirs);
			const timeoutSeconds = clampTimeoutSeconds(params.timeoutSeconds, params.timeoutMinutes);
			const permissionMode = (params.permissionMode ?? "default") as PermissionMode;
			const allowWrites = params.allowWrites === true;
			const model = params.model?.trim() || undefined;
			const detachedTerminal = params.detachedTerminal === true;

			if (permissionMode === "autoApprove") {
				if (!allowWrites) {
					throw new Error("permissionMode='autoApprove' requires allowWrites=true. Use sandbox/default for read-only delegation.");
				}
				if (!ctx.hasUI) {
					throw new Error("permissionMode='autoApprove' requires interactive user confirmation, but no UI is available.");
				}
				const ok = await ctx.ui.confirm(
					"Allow agy auto-approve?",
					"agy_delegate was asked to run agy with --dangerously-skip-permissions and allowWrites=true. This may modify files without further permission prompts. Continue?",
					{ timeout: 15000 },
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "agy_delegate cancelled: user did not approve auto-approve write mode." }],
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
						} satisfies AgyDelegateDetails,
					};
				}
			}

			if (detachedTerminal) {
				const start = Date.now();
				const reportFile = createTempReportFile(task);
				const prompt = withReportInstruction(task, reportFile);
				const terminalAddDirs = Array.from(new Set([...addDirs, dirname(reportFile)]));
				const command = buildInteractiveArgs({ addDirs: terminalAddDirs, model, permissionMode, prompt });
				const redactedCommand = redactPrompt(command, prompt);
				const launched = launchDetachedTerminal(command, ctx.cwd);
				const displayCommand = [findAgyExecutable(), ...redactedCommand];
				const launcherCommand = launched.command.map((arg) => (arg === prompt ? "<prompt>" : arg));
				const durationMs = Date.now() - start;
				const text = [
					"# agy_delegate detached",
					"",
					"已在独立终端启动交互式 agy。pi 不会捕获该终端的完整输出，因此不会把过程写入上下文。",
					"",
					`- reportFile: ${reportFile}`,
					launched.pid ? `- pid: ${launched.pid}` : undefined,
					`- launcher: ${shellDisplay(launcherCommand)}`,
					`- command: ${shellDisplay(displayCommand)}`,
					"",
					"agy 结束后会尝试把最终摘要写入上面的临时 Markdown 文件；需要时再让 pi 读取该文件即可。",
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text", text }],
					details: {
						mode,
						addDirs: terminalAddDirs,
						timeoutSeconds,
						permissionMode,
						allowWrites,
						model,
						runner: "detached",
						command: displayCommand,
						exitCode: null,
						durationMs,
						reportFile,
					} satisfies AgyDelegateDetails,
				};
			}

			const prompt = task;
			const command = buildArgs({ addDirs, timeoutSeconds, model, permissionMode, prompt });
			const redactedCommand = redactPrompt(command, prompt);
			const displayCommand = ["agy", ...redactedCommand];
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

			emitUpdate("(starting agy...)");
			const result = await runAgy(command, ctx.cwd, timeoutSeconds * 1000 + 30_000, signal, emitUpdate);
			const durationMs = Date.now() - start;
			const stdout = result.stdout ?? "";
			const stderr = result.stderr ?? "";
			const combined = [stdout.trimEnd(), stderr.trimEnd() ? `\n\n[stderr]\n${stderr.trimEnd()}` : ""].join("").trim();

			const baseBody = combined || lastStreamText || "(agy produced no stdout/stderr. If runner=exec, install node-pty or run /reload after installing it.)";
			const authRequired = detectAuthRequired(baseBody);
			const body = authRequired ? `${baseBody}\n\n${formatAuthRequiredNote(baseBody)}` : baseBody;
			const resultMarkdown = formatLiveOutput({
				runner: result.runner,
				exitCode: result.code,
				durationMs,
				captureTruncated: result.captureTruncated,
				command: displayCommand,
				body,
			}).replace("# agy_delegate streaming", "# agy_delegate result");

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

			const details: AgyDelegateDetails = {
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
				authRequired: authRequired || undefined,
			};

			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	});
}
