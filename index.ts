import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextGrowth from "./extensions/context-growth";

export default function (pi: ExtensionAPI) {
	contextGrowth(pi);
}
