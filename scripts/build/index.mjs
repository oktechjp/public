import sharp from 'sharp'
import { readFile, readdir, writeFile, mkdir, access, cp } from 'node:fs/promises'
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

async function preparePhoto ({ cwd, file, targetFolder, transforms, sharps, copies }) {
  // Note: this is a bit of a hack, but "res" is filled only while the sharps are processed
  //       Kind of backwards nbut it works :sweat:
  const res = {}
  const src = join(cwd, file)
  const base = join(targetFolder, removeExt(file))
  sharps.push(...transforms.map(transform => (
    {
      res,
      src,
      base,
      transform
    }
  )))
  copies.push({ src, target: join(targetFolder, file) })
  return {
    file,
    corners: toHexColors(Array.from(await sharp(src).resize(2, 2).toFormat('raw').toBuffer())),
    res
  }
}

async function processImages ({ targetFolder, cwd, transforms }) {
  const albumData = await processPhotoAlbums({ targetFolder, cwd, transforms })
  const eventData = await processEventsImages({ targetFolder, cwd, transforms })
  await pmap([...albumData.copies, ...eventData.copies], async ({ src, target }) => copy(src, target, true))
  await pmap([...albumData.sharps, ...eventData.sharps], async ({ res, src, base, transform }) => {
    let s = sharp(src)
    if (transform.resize) {
      s = s.resize(transform.resize)
    }
    let first = true
    for (const format of transform.formats) {
      const target = `${base}@${transform.key}.${format}`
      try {
        await access(target)
        log('TRANSFORM', `${relative(cwd, src)} key=${transform.key} format=${format} -> cached`)
      } catch (err) {
        await mkdir(dirname(target), { recursive: true })
        log('TRANSFORM', `${relative(cwd, src)} key=${transform.key} format=${format} -> writing`)
        await s.withMetadata().toFile(target)
      }
      if (first) {
        first = false
        const metadata = await sharp(target).metadata()
        res[transform.key] = [ metadata.width, metadata.height ]
      }
    }
  }, { concurrency: 5 })
  await albumData.finalize()
  return await eventData.finalize()
}

async function processEventsImages ({ targetFolder, cwd, transforms }) {
  const sharps = []
  const copies = []
  const eventsData = await readJSON(join(cwd, 'events.json'))
  const events = []
  for (const groupEvents of Object.values(eventsData.events)) {
    events.push(...groupEvents.filter(event => event.featured_photo))
  }
  await pmap(events, async event => {
    event.featured_photo = await preparePhoto({
      cwd,
      file: join('images', 'events', `${event.id}.webp`),
      sharps,
      copies,
      targetFolder,
      transforms
    })
  }, { concurrency: 5 })
  return {
    sharps,
    copies,
    async finalize () {
      for (const event of events) {
        event.featured_photo = {
          ...event.featured_photo,
          res: transforms.map(transform => event.featured_photo.res[transform.key])
        }
      }
      await writeJSON(join(targetFolder, 'events.json'), {
        transforms,
        ...eventsData
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
    for (const file of group.photos) {
      const target = {}
      allPhotos.push({ file, target })
      targetGroup.photos.push(target)
    }
    return targetGroup
  })
  await pmap(allPhotos,
    async ({ file, target }) => {
      Object.assign(target, await preparePhoto({
        cwd,
        file,
        sharps,
        copies,
        targetFolder,
        transforms
      }))
    },
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
