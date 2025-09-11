import { join } from "node:path";
import pmap from "p-map";
import { writeJSON, readJSON } from "./util.mjs";
import { preparePhoto } from "./prepare-photo.mjs";

export async function processPhotoAlbums({ targetFolder, cwd, transforms }) {
  const sharps = [];
  const copies = [];
  const photos = await readJSON(join(cwd, "photos.json"));
  const allPhotos = [];
  const groups = photos.groups
    .filter((group) => !group.removed)
    .map((group) => {
      const targetGroup = {
        ...group,
        photos: [],
      };
      group.photos = group.photos.filter((photo) => !photo.removed);
      for (const photo of group.photos) {
        const target = {
          file: photo.location,
          instructional: photo.instructional,
          caption: photo.caption,
          res: {},
        };
        allPhotos.push(target);
        targetGroup.photos.push(target);
      }
      return targetGroup;
    });
  await pmap(
    allPhotos,
    async (target) =>
      await preparePhoto({
        cwd,
        sharps,
        copies,
        target,
        targetFolder,
        transforms,
      }),
    { concurrency: 5 },
  );
  return {
    sharps,
    copies,
    finalize: () =>
      writeJSON(join(targetFolder, "photos.json"), {
        transforms,
        ...photos,
        groups: groups.map((group) => {
          return {
            ...group,
            photos: group.photos.map((photo) => ({
              ...photo,
              res: transforms.map((transform) => photo.res[transform.key]),
            })),
          };
        }),
      }),
  };
}
