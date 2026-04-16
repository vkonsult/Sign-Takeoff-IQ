import fs from "fs";
import { db } from "@workspace/db";
import { jobFilesTable } from "@workspace/db";
import { invalidatePdfCaches } from "./pdf-words";

interface WatchEntry {
  fileId: string;
  watcher: fs.FSWatcher;
}

/**
 * Module-level registry of active file watchers.
 * Keyed by the absolute stored path of each PDF.
 */
const watchers = new Map<string, WatchEntry>();

/**
 * Start watching `pdfPath` for on-disk writes.
 *
 * When `fs.watch` fires a "change" or "rename" event for `pdfPath`, both
 * caches in `pdf-words.ts` are invalidated so the next read re-parses the
 * file from disk instead of serving stale data.
 *
 * If `pdfPath` is already watched, only the `fileId` is updated (the existing
 * OS watcher is reused).  This covers the case where an admin-level "replace
 * file" endpoint reassigns the same path to a new file record.
 *
 * Errors from `fs.watch` itself (e.g. the file is later deleted) are caught
 * and the entry is silently removed — a stale-cache issue is always
 * preferable to a crashing server.
 */
export function watchPdfFile(pdfPath: string, fileId: string): void {
  const existing = watchers.get(pdfPath);
  if (existing) {
    existing.fileId = fileId;
    return;
  }

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(pdfPath, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        const entry = watchers.get(pdfPath);
        if (entry) {
          invalidatePdfCaches(pdfPath, entry.fileId);
        }
      }
    });
  } catch {
    return;
  }

  watcher.on("error", () => {
    watchers.delete(pdfPath);
  });

  watchers.set(pdfPath, { fileId, watcher });
}

/**
 * Stop watching `pdfPath`.  Closes the underlying `FSWatcher` and removes
 * the entry from the registry.  Safe to call for paths that are not watched.
 *
 * Intended for cleanup in tests and for future "delete file" endpoints.
 */
export function unwatchPdfFile(pdfPath: string): void {
  const entry = watchers.get(pdfPath);
  if (!entry) return;
  try { entry.watcher.close(); } catch { /* ignore */ }
  watchers.delete(pdfPath);
}

/**
 * Stop all active watchers.  Useful for graceful server shutdown or test teardown.
 */
export function unwatchAllPdfFiles(): void {
  for (const [pdfPath] of watchers) {
    unwatchPdfFile(pdfPath);
  }
}

/**
 * Query the database for all existing file records and register a file-system
 * watcher for each `storedPath`.
 *
 * Call this once at server startup so that any admin-level replacement of
 * pre-existing PDF files on disk is also caught by the cache-invalidation
 * watcher — not only files uploaded during the current server process lifetime.
 *
 * Paths that no longer exist on disk are silently skipped (`watchPdfFile`
 * catches the `fs.watch` error internally).
 */
export async function registerExistingFileWatchers(): Promise<void> {
  const files = await db.select({ id: jobFilesTable.id, storedPath: jobFilesTable.storedPath }).from(jobFilesTable);
  for (const file of files) {
    watchPdfFile(file.storedPath, file.id);
  }
}

export const __watchers = watchers;
