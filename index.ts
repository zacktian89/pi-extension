import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextGrowth from "./extensions/context-growth";
import modelUsageReport from "./extensions/model-usage-report";

export default function (pi: ExtensionAPI) {
	contextGrowth(pi);
	modelUsageReport(pi);
}
