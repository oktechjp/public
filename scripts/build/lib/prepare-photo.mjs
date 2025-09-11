import sharp from "sharp";
import { join } from "node:path";

function toHex(col) {
  return col.toString(16).padStart(2, "0");
}

function toHexColor(rgbs, i) {
  return `${rgbs
    .slice(i, i + 3)
    .map(toHex)
    .join("")}`;
}

function removeExt(filename) {
  const d = filename.lastIndexOf(".");
  if (d === -1) return filename;
  return filename.substring(0, d);
}

export async function preparePhoto({
  cwd,
  targetFolder,
  transforms,
  sharps,
  copies,
  target,
}) {
  const src = join(cwd, target.file);
  const base = join(targetFolder, removeExt(target.file));
  sharps.push(
    ...transforms.map((transform) => ({
      src,
      // Note: this is a bit of a hack, but "target.res" is filled only while the sharps are processed
      //       Kind of backwards nbut it works :sweat:
      target,
      base,
      transform,
    })),
  );
  copies.push({ src, target: join(targetFolder, target.file) });
  if (!target.corners) {
    try {
      const base = await sharp(src)
        .resize({
          width: 80,
          height: 80,
          fit: "fill",
        })
        .normalize()
        .modulate({
          saturation: 1.5,
        })
        .toColorspace("srgb")
        .toFormat("tiff")
        .toBuffer();
      const x3y3 = Array.from(
        await sharp(base)
          .resize({
            width: 3,
            height: 3,
            fit: "fill",
          })
          .toFormat("raw")
          .toBuffer(),
      );
      target.corners = [
        toHexColor(x3y3, 0),
        toHexColor(x3y3, 2 * 3),
        toHexColor(x3y3, 6 * 3),
        toHexColor(x3y3, 8 * 3),
      ];
    } catch (cause) {
      throw new Error(`Unable to process corners for ${src}`, { cause });
    }
  }
}
