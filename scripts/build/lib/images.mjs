import pmap from "p-map";
import { copy } from "./util.mjs";
import { processPhotoAlbums } from "./images-photo-albums.mjs";
import { processEventsImages } from "./images-event-images.mjs";

export async function processImages({ targetFolder, cwd }) {
  const eventData = await processEventsImages({
    targetFolder,
    cwd,
  });
  const albumData = await processPhotoAlbums({ targetFolder, cwd });
  await pmap(
    [...albumData.copies, ...eventData.copies],
    async ({ src, target }) => copy(src, target, true),
  );
  return {
    photos: await albumData.finalize(),
    events: await eventData.finalize(),
  };
}
