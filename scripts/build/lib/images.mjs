import sharp from "sharp";
import { mkdir, access, unlink } from "node:fs/promises";
import { relative, dirname } from "node:path";
import pmap from "p-map";
import { log, copy } from "./util.mjs";
import { processPhotoAlbums } from "./images-photo-albums.mjs";
import { processEventsImages } from "./images-event-images.mjs";

export async function processImages({ targetFolder, cwd, transforms }) {
  const eventData = await processEventsImages({
    targetFolder,
    cwd,
    transforms,
  });
  const albumData = await processPhotoAlbums({ targetFolder, cwd, transforms });
  await pmap(
    [...albumData.copies, ...eventData.copies],
    async ({ src, target }) => copy(src, target, true),
  );
  await pmap(
    [...albumData.sharps, ...eventData.sharps],
    async ({ src, target, base, transform }) => {
      let s = sharp(src);
      if (transform.resize) {
        s = s.resize(transform.resize);
      }
      let first = true;
      for (const format of transform.formats) {
        let attempt = 0;
        while (true) {
          const formatFile = `${base}@${transform.key}.${format}`;
          try {
            await access(formatFile);
            log(
              "TRANSFORM",
              `${relative(cwd, src)} key=${transform.key} format=${format} -> ${relative(cwd, formatFile)} cached`,
            );
          } catch (err) {
            await mkdir(dirname(formatFile), { recursive: true });
            log(
              "TRANSFORM",
              `${relative(cwd, src)} key=${transform.key} format=${format} -> ${relative(cwd, formatFile)} writing`,
            );
            try {
              await s.withMetadata().toFile(formatFile);
              await new Promise((resolve) => setTimeout(resolve, 30));
            } catch (cause) {
              return new Error(`Can not transform ${src}: ${cause.message}`, {
                cause,
              });
            }
          }
          let metadata;
          try {
            metadata = await sharp(formatFile).metadata();
          } catch (cause) {
            if (attempt === 3) {
              log(
                "TRANSFORM",
                `WARN: Can not get metadata from ${formatFile} (attempt=${attempt}): ${cause.message}`,
                { cause },
              );
              break;
            } else {
              attempt += 1;
              log(
                "TRANSFORM",
                `Reattempting to write ${formatFile} (attempt=${attempt}): ${cause.message}`,
              );
              try {
                await unlink(formatFile);
              } catch (err) {
                log(
                  "TRANSFORM",
                  `Unlinking failed with "${err.message}" because of -> ${cause.message}`,
                );
              }
              continue;
            }
          }
          if (first && metadata) {
            first = false;
            target.res[transform.key] = [metadata.width, metadata.height];
          }
          break;
        }
      }
    },
    { concurrency: 3 },
  );
  return {
    photos: await albumData.finalize(),
    events: await eventData.finalize(),
  };
}
