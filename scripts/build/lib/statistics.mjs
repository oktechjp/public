import { join, relative } from "node:path";
import { copy } from "./util.mjs";

export async function processStatistics({ targetFolder, stats, cwd }) {
  const result = {};
  for (const [name, file] of Object.entries(stats)) {
    const targetFile = join(targetFolder, "stats", "survey.json");
    await copy(join(cwd, file), targetFile);
    result[name] = relative(targetFolder, targetFile);
    return {
      survey: relative(targetFolder, targetFile),
    };
  }
  return result;
}
