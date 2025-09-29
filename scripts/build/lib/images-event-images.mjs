import { join } from "node:path";
import pmap from "p-map";
import { writeJSON, readJSON } from "./util.mjs";
import { preparePhoto } from "./prepare-photo.mjs";

export async function processEventsImages({ targetFolder, cwd }) {
  const copies = [];
  const eventsJSON = await readJSON(join(cwd, "events.json"));
  const { groups } = eventsJSON;
  const photos = [];
  for (const group of Object.values(groups)) {
    for (const event of group.events) {
      if (event.image) {
        event.image = {
          caption: event.image.caption,
          file: event.image.location,
          res: event.image.res,
        };
        photos.push(event.image);
      }
    }
  }
  await pmap(
    photos,
    async (photo) => {
      photo.res = {};
      await preparePhoto({
        cwd,
        copies,
        target: photo,
        targetFolder,
      });
    },
    { concurrency: 5 },
  );
  return {
    copies,
    async finalize() {
      return await writeJSON(join(targetFolder, "events.json"), eventsJSON);
    },
  };
}
