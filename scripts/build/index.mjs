import { join, relative } from "node:path";
import { log, writeJSON, readJSON, copyFolderWithIndex } from "./lib/util.mjs";
import { processStatistics } from "./lib/statistics.mjs";
import { processImages } from "./lib/images.mjs";

export async function main({ cwd, stats, transforms }) {
  transforms = Object.keys(transforms)
    .sort()
    .map((key) => ({ key, ...transforms[key] }));
  const targetFolder = join(cwd, "public");
  log("START", `Running with target folder ${targetFolder}`);
  const [{ events, photos }, statistics, logo] = await Promise.all([
    processImages({ targetFolder, cwd, transforms }),
    processStatistics({ targetFolder, stats, cwd }),
    copyFolderWithIndex({ targetFolder, cwd, folder: "images/logo-and-design" })
  ]);
  await writeJSON(join(targetFolder, "index.json"), {
    ...(await readJSON(join(cwd, "index.json"))),
    license:
      "https://creativecommons.org/licenses/by-nc-sa/4.0/ unless otherwise noted",
    photos: relative(targetFolder, photos),
    events: relative(targetFolder, events),
    logo: relative(targetFolder, logo),
    statistics,
  });
  log("END", "done.");
}
