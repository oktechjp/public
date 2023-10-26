import sharp from 'sharp'
import { readFile, writeFile, mkdir, access, cp, unlink, readdir } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import stringify from 'json-stringify-pretty-compact'
import pmap from 'p-map'

const write = async (path, data) => {
  log('WRITE', `${path}`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}
const writeJSON = async (path, data) => {
  await write(path, stringify(data))
}
const copy = async (src, target, soft=false) => {
  if (soft) {
    try {
      await access(target)
      log('COPY', `${src} → ${target} [cached]`)
      return
    } catch (err) {}
  }
  log('COPY', `${src} → ${target}`)
  await mkdir(dirname(target), { recursive: true })
  await cp(src, target)
}
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'))

export async function main ({ cwd, stats, transforms }) {
  transforms = Object.keys(transforms).sort().map(key => ({ key, ...transforms[key] }))
  const targetFolder = join(cwd, 'public')
  log('START', `Running with target folder ${targetFolder}`)
  const [events, statistics] = await Promise.all([
    processImages({ targetFolder, cwd, transforms }),
    processStatistics({ targetFolder, stats, cwd })
  ])
  await writeJSON(join(targetFolder, 'index.json'), {
    license: 'https://creativecommons.org/licenses/by-nc-sa/4.0/ unless otherwise noted',
    photos: 'photos.json',
    events,
    statistics
  })
  log('END', 'done.')
}

async function processStatistics ({ targetFolder, stats, cwd }) {
  const result = {}
  for (const [name, file] of Object.entries(stats)) {
    const targetFile = join(targetFolder, 'stats', 'survey.json')
    await copy(join(cwd, file), targetFile)
    result[name] = relative(targetFolder, targetFile)
    return {
      survey: relative(targetFolder, targetFile)
    }
  }
  return result
}

function removeExt (filename) {
  const d = filename.lastIndexOf('.')
  if (d === -1) return filename
  return filename.substring(0, d)
}

function toHex (col) {
  return col.toString(16).padStart(2, '0')
}

function toHexColor (rgbs, i) {
  return `${rgbs.slice(i, i + 3).map(toHex).join('')}`
}

const start = Date.now()
function log (group, msg) {
  console.log((Date.now() - start).toString().padEnd(5, ' '), `[${group}]`.padEnd(8, ' '), msg)
}

async function preparePhoto ({ cwd, targetFolder, transforms, sharps, copies, target }) {
  const src = join(cwd, target.file)
  const base = join(targetFolder, removeExt(target.file))
  sharps.push(...transforms.map(transform => (
    {
      src,
      // Note: this is a bit of a hack, but "target.res" is filled only while the sharps are processed
      //       Kind of backwards nbut it works :sweat:
      target,
      base,
      transform
    }
  )))
  copies.push({ src, target: join(targetFolder, target.file) })
  if (!target.corners) {
    try {
      const base = await sharp(src)
        .resize({
          width: 80,
          height: 80,
          fit: 'fill'
        })
        .normalize()
        .modulate({
          saturation: 1.5
        })
        .toColorspace('srgb')
        .toFormat('tiff')
        .toBuffer()
      const x3y3 = Array.from(await sharp(base)
        .resize({
          width: 3,
          height: 3,
          fit: 'fill',
        })
        .toFormat('raw')
        .toBuffer()
      )
      target.corners = [
        toHexColor(x3y3, 0),
        toHexColor(x3y3, 2 * 3),
        toHexColor(x3y3, 6 * 3),
        toHexColor(x3y3, 8 * 3)
      ]
    } catch (cause) {
      throw new Error(`Unable to process corners for ${src}`, { cause })
    }
  }
}

async function processImages ({ targetFolder, cwd, transforms }) {
  const eventData = await processEventsImages({ targetFolder, cwd, transforms })
  const albumData = await processPhotoAlbums({ targetFolder, cwd, transforms })
  await pmap([...albumData.copies, ...eventData.copies], async ({ src, target }) => copy(src, target, true))
  await pmap([...albumData.sharps, ...eventData.sharps], async ({ src, target, base, transform }) => {
    let s = sharp(src)
    if (transform.resize) {
      s = s.resize(transform.resize)
    }
    let first = true
    for (const format of transform.formats) {
      let attempt = 0
      while (true) {
        const formatFile = `${base}@${transform.key}.${format}`
        try {
          await access(formatFile)
          log('TRANSFORM', `${relative(cwd, src)} key=${transform.key} format=${format} -> ${relative(cwd, formatFile)} cached`)
        } catch (err) {
          await mkdir(dirname(formatFile), { recursive: true })
          log('TRANSFORM', `${relative(cwd, src)} key=${transform.key} format=${format} -> ${relative(cwd, formatFile)} writing`)
          try {
            await s.withMetadata().toFile(formatFile)
            await new Promise(resolve => setTimeout(resolve, 30))
          } catch (cause) {
            return new Error(`Can not transform ${src}: ${cause.message}`, { cause })
          }
        }
        let metadata
        try {
          metadata = await sharp(formatFile).metadata()
        } catch (cause) {
          if (attempt === 3) {
            log('TRANSFORM', `WARN: Can not get metadata from ${formatFile} (attempt=${attempt}): ${cause.message}`, { cause })
            break
          } else {
            attempt += 1
            log('TRANSFORM', `Reattempting to write ${formatFile} (attempt=${attempt}): ${cause.message}`)
            try {
              await unlink(formatFile)
            } catch (err) {
              log('TRANSFORM', `Unlinking failed with "${err.message}" because of -> ${cause.message}`)
            }
            continue
          }
        }
        if (first && metadata) {
          first = false
          target.res[transform.key] = [ metadata.width, metadata.height ]
        }
        break
      }
    }
  }, { concurrency: 3 })
  await albumData.finalize()
  return await eventData.finalize()
}

async function processEventsImages ({ targetFolder, cwd, transforms }) {
  const sharps = []
  const copies = []
  const eventsJSON = await readJSON(join(cwd, 'events.json'))
  const { groups } = eventsJSON
  const photos = []
  for (const group of Object.values(groups)) {
    for (const event of group.events) {
      if (event.image) {
        event.image = {
          caption: event.image.caption,
          file: event.image.location,
          res: event.image.res
        }
        photos.push(event.image)
      }
    }
  }
  await pmap(photos, async photo => {
    photo.res = {}
    await preparePhoto({
      cwd,
      sharps,
      copies,
      target: photo,
      targetFolder,
      transforms
    })
  }, { concurrency: 5 })
  return {
    sharps,
    copies,
    async finalize () {
      for (const photo of photos) {
        photo.res = transforms.map(transform => photo.res[transform.key])
      }
      await writeJSON(join(targetFolder, 'events.json'), {
        transforms,
        ...eventsJSON
      })
      return 'events.json'
    }
  }
}

async function processPhotoAlbums ({ targetFolder, cwd, transforms }) {
  const sharps = []
  const copies = []
  const photos = await readJSON(join(cwd, 'photos.json'))
  const allPhotos = []
  const groups = photos.groups.map(group => {
    const targetGroup = {
      ...group,
      photos: []
    }
    group.photos = group.photos.filter(photo => !photo.removed)
    for (const photo of group.photos) {
      const target = {
        file: photo.location,
        instructional: photo.instructional,
        caption: photo.caption,
        res: {}
      }
      allPhotos.push(target)
      targetGroup.photos.push(target)
    }
    return targetGroup
  })
  await pmap(allPhotos, async target =>
    await preparePhoto({
      cwd,
      sharps,
      copies,
      target,
      targetFolder,
      transforms
    }),
    { concurrency: 5 }
  )
  return {
    sharps,
    copies,
    async finalize () {
      await writeJSON(join(targetFolder, 'photos.json'), {
        transforms,
        ...photos,
        groups: groups.map(group => {
          return {
            ...group,
            photos: group.photos.map(photo => ({
              ...photo,
              res: transforms.map(transform => photo.res[transform.key])
            }))
          }
        })
      })
    }
  }
}
