// Pure recovery of absolute local paths from a file drop's DataTransfer:
// file:// URI decoding across drive/POSIX/UNC shapes, the layered format
// lookup, and file/path pairing.
import { describe, expect, it } from 'vitest'
import { droppedFilePaths, matchDroppedPaths, pathFromFileUrl } from '../src/client/input/dropped-paths.ts'

describe('pathFromFileUrl', () => {
  it('decodes a Windows drive URI, percent-escapes included', () => {
    expect(pathFromFileUrl('file:///C:/Users/%E5%BC%A0%E4%B8%89/ref%20file.md')).toBe('C:/Users/张三/ref file.md')
  })

  it('decodes a POSIX absolute URI without touching its root slash', () => {
    expect(pathFromFileUrl('file:///home/u/a b.txt')).toBe('/home/u/a b.txt')
  })

  it('decodes a UNC URI to the Windows server/share spelling', () => {
    expect(pathFromFileUrl('file://server/share/dir/x.txt')).toBe('\\\\server\\share\\dir\\x.txt')
  })

  it('accepts the bare file:/absolute form and strips a fragment', () => {
    expect(pathFromFileUrl('file:/var/log/app.log#L3')).toBe('/var/log/app.log')
  })

  it('rejects malformed escapes, relative targets, hosts without paths, and non-file URIs', () => {
    expect(pathFromFileUrl('file:///C:/bad%zz.txt')).toBeUndefined()
    expect(pathFromFileUrl('file:relative.txt')).toBeUndefined()
    expect(pathFromFileUrl('file://server')).toBeUndefined()
    expect(pathFromFileUrl('http://example.com/a')).toBeUndefined()
    expect(pathFromFileUrl('')).toBeUndefined()
  })
})

describe('droppedFilePaths', () => {
  const getData = (table: Record<string, string>) => (type: string) => table[type] ?? ''

  it('prefers text/uri-list over the later formats and decodes every line in order', () => {
    const paths = droppedFilePaths(getData({
      'text/uri-list': 'file:///C:/a.txt\r\nfile:///C:/b%20b.txt',
      'public.file-url': 'file:///C:/ignored.txt',
    }))
    expect(paths).toEqual(['C:/a.txt', 'C:/b b.txt'])
  })

  it('falls back to public.file-url when the uri-list is empty', () => {
    const paths = droppedFilePaths(getData({
      'text/uri-list': '',
      'public.file-url': 'file:///Users/me/a.txt',
    }))
    expect(paths).toEqual(['/Users/me/a.txt'])
  })

  it('falls back to bare absolute Windows paths in the plain-text payload', () => {
    const paths = droppedFilePaths(getData({ 'text/plain': 'not a path\nC:\\Docs\\spec.pdf\r\nplain note' }))
    expect(paths).toEqual(['C:\\Docs\\spec.pdf'])
  })

  it('deduplicates repeated paths and returns empty for absent or empty sources', () => {
    expect(droppedFilePaths(getData({ 'text/uri-list': 'file:///C:/a\nfile:///C:/a' }))).toEqual(['C:/a'])
    expect(droppedFilePaths(getData({}))).toEqual([])
    expect(droppedFilePaths(undefined)).toEqual([])
  })
})

describe('matchDroppedPaths', () => {
  it('pairs by position when the counts agree', () => {
    expect(matchDroppedPaths(
      [{ name: 'a.txt' }, { name: 'b.txt' }],
      ['C:/x/a.txt', 'C:/y/b.txt'],
    )).toEqual(['C:/x/a.txt', 'C:/y/b.txt'])
  })

  it('pairs by case-insensitive basename against the first unused candidate when counts differ', () => {
    expect(matchDroppedPaths(
      [{ name: 'a.txt' }, { name: 'c.txt' }, { name: 'b.txt' }],
      ['C:/y/B.TXT', 'C:/x/a.txt'],
    )).toEqual(['C:/x/a.txt', undefined, 'C:/y/B.TXT'])
  })

  it('leaves files undefined when no candidate matches and tolerates empty paths', () => {
    expect(matchDroppedPaths([{ name: 'a.txt' }, { name: 'z.txt' }], ['C:/x/a.txt']))
      .toEqual(['C:/x/a.txt', undefined])
    expect(matchDroppedPaths([{ name: 'a.txt' }], [])).toEqual([undefined])
  })
})
