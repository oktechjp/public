import { join } from "node:path";

export async function preparePhoto({
  cwd,
  targetFolder,
  copies,
  target,
}) {
  const src = join(cwd, target.file);
  copies.push({ src, target: join(targetFolder, target.file) });
}
