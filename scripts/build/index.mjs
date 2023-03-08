import sharp from 'sharp'
import { readFile, readdir, writeFile, mkdir, access, cp } from 'node:fs/promises'
import { join, relative, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import stringify from 'json-stringify-pretty-compact'
import pmap from 'p-map'

export async function main ({ albums, images, cwd, stats, sizes, formats }) {
  sizes = sizes.sort(byNumber)
  const targetFolder = join(cwd, 'public')
  await mkdir(targetFolder, { recursive: true })
  log('START', `Running with target folder ${targetFolder}`)
  const [[albumData, eventsData], statistics] = await Promise.all([
    processImages({ targetFolder, albums, images, cwd, sizes, formats }),
    processStatistics({ targetFolder, stats, cwd })
  ])
  log('WRITE', 'index.json')
  await writeFile(join(targetFolder, 'index.json'), stringify({
    license: 'https://creativecommons.org/licenses/by-nc-sa/4.0/ unless otherwise noted',
    albums: albumData,
    events: eventsData,
    statistics
  }))
  log('END', 'done.')
}

async function processStatistics ({ targetFolder, stats, cwd }) {
  const result = {}
  for (const [name, file] of Object.entries(stats)) {
    const targetFile = join(targetFolder, 'stats', 'survey.json')
    await mkdir(dirname(targetFile), { recursive: true })
    const src = join(cwd, file)
    await writeFile(targetFile, await readFile(src))
    log('STATS', `copied ${src} → ${targetFile}`)
    result[name] = relative(targetFolder, targetFile)
    return {
      survey: relative(targetFolder, targetFile)
    }
  }
  return result
}

function hash (input) {
  const h = createHash('sha1')
  h.write(JSON.stringify(input))
  const urlsafeB64 = h.digest().toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return [...urlsafeB64.slice(0, 2), urlsafeB64.slice(2)]
}

function removeExt (filename) {
  const d = filename.lastIndexOf('.')
  if (d === -1) return filename
  return filename.substring(0, d)
}

function toHexColors (rgbs) {
  const colors = []
  for (let i = 0; i < rgbs.length; i += 3) {
    colors.push(`${rgbs.slice(i, i + 3).map(col => col.toString(16).padStart(2, '0')).join('')}`)
  }
  return colors
}

const start = Date.now()
function log (group, msg) {
  console.log((Date.now() - start).toString().padEnd(5, ' '), `[${group}]`.padEnd(8, ' '), msg)
}

async function preparePhoto ({ src, targetFolder, id, sizes, formats }) {
  // Note: this is a bit of a hack, but "res" is filled only while the sharps are processed
  //       Kind of backwards nbut it works :sweat:
  const res = {}
  const name = removeExt(basename(src))
  const sharps = []
  const imageFolder = join(targetFolder, 'p', ...hash(id))
  for (const size of sizes) {
    const target = join(imageFolder, `${size.toString()}@${name}`)
    for (const format of formats) {
      sharps.push({
        res,
        src,
        size,
        target: `${target}.${format}`,
        format
      })
    }
  }
  return {
    sharps,
    photo: {
      name,
      folder: relative(targetFolder, imageFolder),
      // description: aData.description || undefined /* undefined is not rendered in json! */,
      corners: toHexColors(Array.from(await sharp(src).resize(2, 2).toFormat('raw').toBuffer())),
      res
    }
  }
}

async function processImages ({ targetFolder, albums, cwd, formats, sizes }) {
  const albumData = await processPhotoAlbums({ targetFolder, folders: albums, cwd, formats, sizes })
  const eventData = await processEventsImages({ targetFolder, cwd, formats, sizes })
  const sharps = [...albumData.sharps, ...eventData.sharps]
  await pmap(sharps, async ({ res, src, target, size }) => {
    try {
      await access(target)
      log('RESIZE', `size=${size} cached: ${relative(cwd, src)}`)
    } catch (err) {
      await mkdir(dirname(target), { recursive: true })
      log('RESIZE', `size=${size} ${relative(cwd, src)} → ${relative(targetFolder, target)}`)
      await sharp(src).resize({
        width: size,
        height: size,
        fit: 'inside'
      }).withMetadata().toFile(target)
    }
    const metadata = await sharp(target).metadata()
    res[size] = [ metadata.width, metadata.height ]
  }, {
    concurrency: 5
  })
  return Promise.all([
    albumData.finalize(),
    eventData.finalize()
  ])
}

async function processEventsImages ({ targetFolder, cwd, formats, sizes }) {
  const sharps = []
  const events = JSON.parse(await readFile(join(cwd, 'events.json')))
  await pmap(events.events, async event => {
    if (event.featured_photo) {
      const photo = await preparePhoto({ src: join(cwd, 'images', 'events', `${event.id}.jpeg`), targetFolder, id: ['images', event.id], sizes, formats })
      sharps.push(...photo.sharps)
      event.featured_photo = photo.photo
    }
  }, { concurrency: 5 })
  return {
    sharps,
    async finalize () {
      await writeFile(join(targetFolder, 'events.json'), stringify({
        formats,
        sizes,
        ...events,
        events: events.events.map(event => ({
          ...event,
          featured_photo: event.featured_photo ? {
            ...event.featured_photo,
            res: sizes.map(size => event.featured_photo.res[size])
          } : undefined
        }))
      }))
      return 'events.json'
    }
  }
}

async function processPhotoAlbums ({ targetFolder, folders, cwd, formats, sizes }) {
  const sharps = []
  const albums = await pmap(folders, async folder => {
    const msgsFolder = join(cwd, folder)
    return {
      folder,
      groups: (await pmap(await readdir(msgsFolder), async msg => {
        const msgFolder = join(msgsFolder, msg)
        let data
        try {
          data = JSON.parse(await readFile(join(msgFolder, 'index.json'), 'utf8'))
        } catch (err) {
          return null
        }
        const photos = []
        log('MSG', `id=${data.id}: ${data.content}`)
        for (const attachment of data.attachments) {
          const aFolder = join(msgFolder, attachment)
          let aData
          try {
            aData = JSON.parse(await readFile(join(aFolder, 'index.json'), 'utf8'))
          } catch (e) {
            log('WARN', `${aFolder} doesnt contain a index.json file: ${e}`)
            continue
          }
          log('PHOTO', `id=${aData.id}`)
          const src = join(aFolder, aData.name)
          const photo = await preparePhoto({ src, targetFolder, sizes, formats, id: ['event-photos', msg, aData.id] })
          sharps.push(...photo.sharps)
          photos.push({
            ...photo.photo,
            description: aData.description || undefined /* undefined is not rendered in json! */
          })
        }
        return {
          id: data.id,
          content: data.content,
          createdTimestamp: data.createdTimestamp,
          editedTimeStamp: data.editedTimeStamp,
          author: data.author,
          photos
        }
      }, { concurrency: 1 })).filter(Boolean)
    }
  })
  return {
    sharps,
    async finalize () {
      return await pmap(albums, async ({ folder, groups }) => {
        const targetFile = join(targetFolder, `${folder}.json`)
        log('WRITE', relative(targetFolder, targetFile))
        await writeFile(targetFile, stringify({
          sizes,
          formats,
          groups: groups.map(group => {
            return {
              ...group,
              photos: group.photos.map(photo => {
                return {
                  ...photo,
                  res: sizes.map(size => photo.res[size])
                }
              })
            }
          })
        }))
        return relative(targetFolder, targetFile)
      })
    }
  }
}

function byNumber (a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
