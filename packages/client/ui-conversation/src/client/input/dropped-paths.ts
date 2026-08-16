/**
 * Recovery of absolute local paths from browser file drops. Every engine
 * removed `File.path`, so the paths a drag source knows — when it advertises
 * them at all — ride the DataTransfer's URI-list formats instead: Chromium
 * fills `text/uri-list` with file:// URIs for files dragged from the OS on
 * Windows and Linux, and WebKit exposes `public.file-url` on macOS. A source
 * that advertises nothing (Firefox) leaves the list empty; the composer then
 * announces the gap instead of guessing a path.
 */

/** Format names a drag source may use to advertise the dropped files' local paths. */
const URI_LIST_TYPES = ['text/uri-list', 'public.file-url'] as const

/** A line that already IS an absolute Windows path (legacy Explorer text/plain payloads). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

/**
 * Decode one file:// URI into its absolute local path.
 * Windows drive paths decode to `C:/…`, POSIX paths to `/…`, and UNC
 * (`file://server/share/x`) to the Windows spelling `\\server\share\x`.
 * @param raw - one URI-list line (a `file:` URI).
 * @returns the decoded path, or undefined when the line is not a decodable
 * absolute file URI.
 */
export function pathFromFileUrl(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '' || !text.toLowerCase().startsWith('file:')) return undefined
  const rest = text.slice('file:'.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return undefined // malformed escapes: the URI cannot name a real path
  }
  const hash = decoded.indexOf('#')
  const body = hash === -1 ? decoded : decoded.slice(0, hash)
  if (!body.startsWith('//')) {
    // file:/absolute/path; a file: URI without an absolute path names nothing.
    return body.startsWith('/') ? body : undefined
  }
  const hostEnd = body.indexOf('/', 2)
  if (hostEnd === -1) return undefined // file://host with no path
  const host = body.slice(2, hostEnd)
  const path = body.slice(hostEnd)
  if (host === '') {
    // file:///C:/x or file:///home/u/x: the path already starts with '/'.
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
  }
  return `\\\\${host}${path.replaceAll('/', '\\')}`
}

/** Decode one plain-text line: a file URI, or a bare absolute Windows path. */
function pathFromPlainLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  return pathFromFileUrl(trimmed) ?? (WINDOWS_ABSOLUTE.test(trimmed) ? trimmed : undefined)
}

/** Split one payload into decoded, deduplicated paths in first-seen order. */
function decodeLines(payload: string, decode: (line: string) => string | undefined): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const line of payload.split(/\r?\n/)) {
    const path = decode(line)
    if (path !== undefined && !seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

/**
 * Recover the absolute local paths one file drop advertised, in advertised
 * order. Reads the URI-list formats first (any non-empty payload wins) and
 * falls back to raw absolute paths in the plain-text payload.
 * @param getData - the drop's DataTransfer.getData, bound to its receiver;
 * absent for transfers that carry no data accessor.
 * @returns the decoded paths; empty when the source advertised none.
 */
export function droppedFilePaths(getData: ((type: string) => string) | undefined): readonly string[] {
  if (getData === undefined) return []
  for (const type of URI_LIST_TYPES) {
    const payload = getData(type)
    if (payload !== '') return decodeLines(payload, pathFromFileUrl)
  }
  return decodeLines(getData('text/plain'), pathFromPlainLine)
}

/** Last path segment, split on the separator the path actually uses. */
function basenameOf(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const index = path.lastIndexOf(separator)
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * Pair each dropped file with its advertised absolute path. Equal counts pair
 * by position (URI lists are emitted in file order); otherwise a file matches
 * by case-insensitive basename against the first unused candidate.
 * @param files - the dropped files, in DataTransfer order.
 * @param paths - decoded paths from {@link droppedFilePaths}.
 * @returns one entry per file, aligned with `files`; undefined = no path.
 */
export function matchDroppedPaths(
  files: readonly { name: string }[],
  paths: readonly string[],
): readonly (string | undefined)[] {
  if (paths.length === files.length) return paths
  const unused = [...paths]
  return files.map((file) => {
    const target = file.name.toLowerCase()
    const index = unused.findIndex(path => basenameOf(path).toLowerCase() === target)
    if (index === -1) return undefined
    const hit = unused[index]
    if (hit === undefined) return undefined
    unused.splice(index, 1)
    return hit
  })
}
