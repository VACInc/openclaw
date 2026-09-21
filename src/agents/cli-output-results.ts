import type { PluginTextReplacement } from "../plugins/cli-backend.types.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { applyPluginTextReplacements } from "./plugin-text-transforms.js";

export function transformCliResultText(
  output: CliOutput,
  replacements?: PluginTextReplacement[],
): CliOutput {
  return {
    ...output,
    rawText: output.text,
    text: applyPluginTextReplacements(output.text, replacements),
    ...(output.textParts
      ? {
          textParts: output.textParts.map((text) =>
            applyPluginTextReplacements(text, replacements),
          ),
        }
      : {}),
  };
}

/** Keep completed answers distinct while retaining cumulative transcript text. */
export function appendCliResultText(previous: CliOutput | null, nextText: string) {
  const previousText = previous?.text.trim() ?? "";
  const completedText =
    previousText && nextText.startsWith(previousText)
      ? nextText.slice(previousText.length).trim()
      : nextText;
  const text =
    previousText && nextText && !nextText.startsWith(previousText)
      ? `${previousText}\n${nextText}`
      : nextText || previousText;
  const textParts = previousText
    ? [...(previous?.textParts ?? [previousText]), ...(completedText ? [completedText] : [])]
    : completedText
      ? [completedText]
      : [];
  return { text, textParts, completedText };
}
