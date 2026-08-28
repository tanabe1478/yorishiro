import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERDICTS: Record<string, string[]> = {
  plan: ["READY", "BLOCKED"],
  implement: ["COMPLETED", "BLOCKED"],
  verify: ["PASS", "FAIL"],
  review: ["APPROVED", "CHANGES_REQUESTED"],
};

async function atomicWrite(file: string, content: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "submit_stage_report",
    label: "Submit Stage Report",
    description: "Write the final scoped pipeline report. This is the only durable write available to read-only stages.",
    parameters: Type.Object({
      verdict: Type.String({ description: "The exact verdict for this stage" }),
      summary: Type.String({ description: "Concise summary" }),
      evidence: Type.String({ description: "Concise evidence and limitations" }),
    }),
    async execute(_id, input: { verdict: string; summary: string; evidence: string }) {
      const file = process.env.YORISHIRO_REPORT_PATH;
      const stage = process.env.YORISHIRO_REPORT_STAGE;
      if (!file || !stage || !VERDICTS[stage]) throw new Error("Scoped stage reporting is not configured");
      if (!VERDICTS[stage].includes(input.verdict)) throw new Error(`Invalid ${stage} verdict`);
      const report = `# ${stage} report\n\n## Summary\n${input.summary.trim()}\n\n## Evidence\n${input.evidence.trim()}\n\nVERDICT: ${input.verdict}\n`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicWrite(file, report);
      return { content: [{ type: "text", text: `Submitted ${stage} report.` }], details: { file } };
    },
  });
}
