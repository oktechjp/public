import stringify from "json-stringify-pretty-compact";
import { readFile, writeFile, mkdir, access, cp, glob } from "node:fs/promises";
import { dirname, join } from "node:path";
import pmap from 'p-map';

const start = Date.now();
export function log(group, msg) {
  console.log(
    (Date.now() - start).toString().padEnd(5, " "),
    `[${group}]`.padEnd(8, " "),
    msg,
  );
}

const write = async (path, data) => {
  log("WRITE", `${path}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
};

export const writeJSON = async (path, data) => {
  await write(path, stringify(data));
  return path;
};

export const copy = async (src, target, soft = false) => {
  if (soft) {
    try {
      await access(target);
      log("COPY", `${src} → ${target} [cached]`);
      return;
    } catch (err) {}
  }
  log("COPY", `${src} → ${target}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(src, target);
};
export const readJSON = async (path) =>
  JSON.parse(await readFile(path, "utf8"));

export async function copyFolderWithIndex({ targetFolder, cwd, folder }) {
  const source = join(cwd, folder);
  const target = join(targetFolder, folder);
  const files = await Array.fromAsync(glob("**/*", { cwd: source }));
  await pmap(
    files,
    file => copy(
      join(source, file),
      join(target, file)
    ),
    {
      concurrency: 10
    }
  )
  return await writeJSON(join(target, 'index.json'), files)
}