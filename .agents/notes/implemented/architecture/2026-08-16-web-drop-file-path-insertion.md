# Agent Note: Web composer drop-file path insertion

Status: implemented

English | [中文](2026-08-16-web-drop-file-path-insertion.zh.md)

## Problem

The web composer accepted only images through paste and drop; referencing a local file meant hand-typing its full path into the draft. The obvious recovery channel is closed by the platform: every engine has removed `File.path` from the drop payload, so a plain browser page cannot read an absolute path off the `File` object itself.

## Decision

Dropped files route by kind in `InputBar`'s document-level drop listener. Image media types keep the existing rail intake (routing uses the host's `imageLimits.mediaTypes`, falling back to the `image/*` prefix without the projection); every other file inserts its absolute local path into the draft at the caret, one path per line, as a single `setDraft` transaction with the DOM-observed edit range (one undo step, the paste path's caret-restore/track dance).

The paths come from the drag source's URI-list formats, recovered by the pure module `packages/client/ui-conversation/src/client/input/dropped-paths.ts`:

- `text/uri-list` (Chromium on Windows/Linux fills it with file:// URIs for OS file drags), then `public.file-url` (WebKit's macOS equivalent), then bare absolute Windows paths in `text/plain` as a legacy fallback.
- `pathFromFileUrl` decodes `file:///C:/…` to `C:/…`, `file:///…` to the POSIX path, and `file://server/share/x` to the UNC spelling `\\server\share\x`; percent-escapes decode, fragments strip, and malformed escapes reject.
- `matchDroppedPaths` pairs paths to files by position when the counts agree (URI lists are emitted in file order), otherwise by case-insensitive basename against the first unused candidate.

A file the browser describes without a path is uploaded to a new loopback-pinned host RPC instead of being guessed. `host.uploadDroppedFile` takes `{ name, content, cwd }` (canonical base64 bytes) and writes them to `<cwd>/.dsh-uploads/<name>` — `cwd` must be the host launch directory or a registered workspace root, the name is a single validated basename, and a repeated name deduplicates with a numeric suffix rather than overwriting. A single file is capped at 20 MB. The written absolute path is what the composer inserts, so a dropped reference file lands as a copy in the project directory with no disk traversal; the original file's location is never needed, matching the read-only "reference" use case. The client calls it through `WorkspacesService.uploadDroppedFile` (injected as the bar's `uploadDroppedFile` face, which reads the `File` bytes and hides the cwd), and the method is pinned to loopback like the other host filesystem methods. While the upload is in flight the composer shows an indeterminate "uploading" strip; a failed upload is counted into one `file.pathUnavailableNamed` toast naming the file. `canAcceptDrop` no longer requires the image service — a composition without one still inserts paths. The drop overlay copy widened from images to files (`drop.*` keys), and the paste gesture is unchanged: it keeps taking images only. The inserted paths are ordinary draft text and reach the model as any typed message does.

## Alternatives considered

- **Host-side filesystem search (name + size over the workspace and common roots)** — the previous cut walked the session workspace, the launch directory, every registered workspace, and the account's Desktop/Downloads/Documents/Pictures to recover the *original* path. Rejected: a reference file is read, not edited, so recovering the original location buys nothing while paying a bounded but real traversal cost and an ambiguity failure mode (same-named, same-sized files, or files outside the roots). Dropped in favor of the upload-to-copy model.
- **URI-list extraction only, with a notice fallback** — relies solely on the drag's URI-list formats and toasts when the browser exposes none. Kept as the fast *first* path (it still returns the original path instantly where the browser offers it), but it cannot be the whole answer: Windows Chrome exposes none.
- **`DataTransferItem.getAsFileSystemHandle()` / the File System Access API** — Chrome grants a handle, never a path, so it cannot satisfy the goal; the show-open-file-picker permission model also has no drop form.
- **Inserting the file name only** — the model would then guess or search for the path, reintroducing exactly the hand-typing cost this feature removes.
- **Chips for dropped paths** — minting `Occurrence` chips would drag the draft through the reference-serialization pipeline for plain text that needs no resolution; plain insertion is the honest shape for a path.

## Verification

`dropped-paths.spec.ts` pins the decoder (drive/POSIX/UNC shapes, percent-escapes, fragments, malformed URIs, format precedence, dedupe) and the pairing rules. `api-proxy-workspace.spec.ts` exercises `host.uploadDroppedFile` through the real `createApiProxy`: the bytes land at `.dsh-uploads/<name>`, a repeated basename deduplicates, and a non-workspace `cwd`, over-limit bytes, and non-canonical base64 each fail with their own code; the RPC round-trips through the fetch carrier and `rpc-schemas.spec.ts` pins the request/value schemas. `workspaces-service.client.spec.ts` pins the client service's payload/path/error mapping. `input-bar.client.spec.tsx` pins the bar behavior over the real `SessionInputShell`: caret insertion, image/file routing, media-type routing, the async upload outcomes (success, partial failure, and the uploading strip). The assembled-application lane (`apps/web/tests/image-display.snapshot.ts`) drops a PDF with a synthetic `text/uri-list` payload over the built client graph and asserts the path lands in the draft with the rail untouched, then drops a file without a path and asserts the `.dsh-uploads` copy path lands.

## Consequences

- Browsers that advertise a URI-list path (WebKit on macOS) insert the original path instantly; every other browser uploads the bytes and inserts the copy's path under `.dsh-uploads/`, so the drop is fast and bounded regardless of where the original lives.
- Dropped reference files are read-only copies: editing the original requires the agent's filesystem tools against the original location, which this path never recovers. Folder drops remain inert (the Files list is empty for directory drags) and are out of scope.
- The upload writes only under known project roots and rejects path-separator names, so a loopback caller cannot use it to write arbitrary files; a single reference file is capped at 20 MB.
- The URI-list path text is not validated client-side: a stale or fabricated entry (e.g. from a synthetic drag) inserts whatever it decodes, exactly as typed text would. The host sandbox and tools remain the authority over whether the path can actually be read.
