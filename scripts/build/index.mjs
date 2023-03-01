import sharp from 'sharp'
import { readFile, readdir, writeFile, mkdir, access, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import stringify from 'json-stringify-pretty-compact'
import pmap from 'p-map'

export async function main ({ folders, cwd, stats, sizes, formats }) {
  sizes = sizes.sort(byNumber)
  const targetFolder = join(cwd, 'public')
  log('START', `Running with target folder ${targetFolder}`)
  const [albums, statistics] = await Promise.all([
    processPhotos({ targetFolder, folders, cwd, sizes, formats }),
    processStatistics({ targetFolder, stats, cwd })
  ])
  log('WRITE', 'index.json')
  await writeFile(join(targetFolder, 'index.json'), stringify({
    albums,
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

function hash (...input) {
  const h = createHash('sha1')
  h.write(JSON.stringify(input))
  const urlsafeB64 = h.digest().toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return [urlsafeB64.slice(0, 2), urlsafeB64.slice(2)]
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

async function processPhotos ({ targetFolder, folders, cwd, formats, sizes }) {
  const sharps = []
  const albums = await pmap(folders, async folder => {
    const msgsFolder = join(cwd, folder)
    const groups = []
    const msgs = await readdir(msgsFolder)
    for (const msg of msgs) {
      const msgFolder = join(msgsFolder, msg)
      let data
      try {
        data = JSON.parse(await readFile(join(msgFolder, 'index.json'), 'utf8'))
      } catch (e) {
        log('WARN', `${msgFolder} doesn't contain a index.json file: ${e}`)
        continue
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
        const res = {}
        const src = join(aFolder, aData.name)
        const imageFolder = join(targetFolder, 'p', ...hash(msg, aData.id))
        let name = removeExt(aData.name)
        photos.push({
          name,
          folder: relative(targetFolder, imageFolder),
          description: aData.description || undefined /* undefined is not rendered in json! */,
          corners: toHexColors(Array.from(await sharp(src).resize(2, 2).toFormat('raw').toBuffer())),
          res
        })
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
      }
      groups.push({
        id: data.id,
        content: data.content,
        createdTimestamp: data.createdTimestamp,
        editedTimeStamp: data.editedTimeStamp,
        author: data.author,
        photos
      })
    }
    return { folder, groups }
  }, {
    concurrency: 5
  })
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
  await mkdir(targetFolder, { recursive: true })
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

function byNumber (a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
