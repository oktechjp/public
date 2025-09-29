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

export async function preparePhoto({
  cwd,
  targetFolder,
  copies,
  target,
}) {
  const src = join(cwd, target.file);
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
