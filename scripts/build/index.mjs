import sharp from 'sharp'
import { readFile, readdir, writeFile, mkdir, access, cp } from 'node:fs/promises'
import { join, relative, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import stringify from 'json-stringify-pretty-compact'
import pmap from 'p-map'

export async function main ({ albums, images, cwd, stats, transforms }) {
  transforms = Object.keys(transforms).sort().map(key => ({ key, ...transforms[key] }))
  const targetFolder = join(cwd, 'public')
  await mkdir(targetFolder, { recursive: true })
  log('START', `Running with target folder ${targetFolder}`)
  const [[albumData, eventsData], statistics] = await Promise.all([
    processImages({ targetFolder, albums, images, cwd, transforms }),
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

async function processImages ({ targetFolder, albums, cwd, transforms }) {
  const albumData = await processPhotoAlbums({ targetFolder, folders: albums, cwd, transforms })
  const eventData = await processEventsImages({ targetFolder, cwd, transforms })
  await pmap([...albumData.copies, ...eventData.copies], async ({ src, target }) => {
    try {
      await access(target)
      log('COPY', `${src} → ${target} [cached]`)
    } catch (err) {
      await mkdir(dirname(target), { recursive: true })
      log('COPY', `${src} → ${target} [copy]`)
      await cp(src, target)
    }
  })
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
  }, {
    concurrency: 5
  })
  return Promise.all([
    albumData.finalize(),
    eventData.finalize()
  ])
}

async function processEventsImages ({ targetFolder, cwd, transforms }) {
  const sharps = []
  const copies = []
  const events = JSON.parse(await readFile(join(cwd, 'events.json')))
  await pmap(events.events, async event => {
    if (event.featured_photo) {
      event.featured_photo = await preparePhoto({
        cwd,
        file: join('images', 'events', `${event.id}.webp`),
        sharps,
        copies,
        targetFolder,
        transforms
      })
    }
  }, { concurrency: 5 })
  return {
    sharps,
    copies,
    async finalize () {
      await writeFile(join(targetFolder, 'events.json'), stringify({
        transforms: transforms.map(({ key }) => key),
        ...events,
        events: events.events.map(event => ({
          ...event,
          featured_photo: event.featured_photo ? {
            ...event.featured_photo,
            res: transforms.map(transform => event.featured_photo.res[transform.key])
          } : undefined
        }))
      }))
      return 'events.json'
    }
  }
}

async function processPhotoAlbums ({ targetFolder, folders, cwd, formats, transforms }) {
  const sharps = []
  const copies = []
  const albums = await pmap(folders, async folder => {
    return {
      folder,
      groups: (await pmap(await readdir(join(cwd, folder)), async msg => {
        const msgFolder = join(folder, msg)
        let data
        try {
          data = JSON.parse(await readFile(join(cwd, msgFolder, 'index.json'), 'utf8'))
        } catch (err) {
          return null
        }
        const photos = []
        log('MSG', `id=${data.id}: ${data.content}`)
        for (const attachment of data.attachments) {
          const aFolder = join(msgFolder, attachment)
          let aData
          try {
            aData = JSON.parse(await readFile(join(cwd, aFolder, 'index.json'), 'utf8'))
          } catch (e) {
            log('WARN', `${aFolder} doesnt contain a index.json file: ${e}`)
            continue
          }
          log('PHOTO', `id=${aData.id}`)
          photos.push({
            ...await preparePhoto({
              cwd,
              file: join(aFolder, aData.name),
              sharps,
              copies,
              targetFolder,
              transforms
            }),
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
    copies,
    async finalize () {
      return await pmap(albums, async ({ folder, groups }) => {
        const targetFile = join(targetFolder, `${folder}.json`)
        log('WRITE', relative(targetFolder, targetFile))
        await writeFile(targetFile, stringify({
          transforms: transforms.map(({ key }) => key),
          formats,
          groups: groups.map(group => {
            return {
              ...group,
              photos: group.photos.map(photo => {
                return {
                  ...photo,
                  res: transforms.map(transform => photo.res[transform.key])
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
