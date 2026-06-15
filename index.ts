import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextGrowth from "./extensions/context-growth";
import codexUsage from "./extensions/codex-usage";

export default function (pi: ExtensionAPI) {
	contextGrowth(pi);
	codexUsage(pi);
}
