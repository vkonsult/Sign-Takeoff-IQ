import path from "path";
import fs from "fs/promises";

const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : path.join(process.cwd(), "data");

export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const PARSED_DIR = path.join(DATA_DIR, "parsed");
export const EXPORTS_DIR = path.join(DATA_DIR, "exports");
export const LOGOS_DIR = path.join(DATA_DIR, "logos");
export const PAGES_DIR = path.join(DATA_DIR, "pages");

export async function ensureDirectories(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(PARSED_DIR, { recursive: true });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  await fs.mkdir(LOGOS_DIR, { recursive: true });
  await fs.mkdir(PAGES_DIR, { recursive: true });
}

/**
 * Returns the directory where pre-rendered page PNGs are stored for a given file.
 * Convention: data/pages/<fileId>/
 */
export function getFilePageImagesDir(fileId: string): string {
  return path.join(PAGES_DIR, fileId);
}

export function getJobUploadDir(jobId: string): string {
  return path.join(UPLOADS_DIR, jobId);
}

export function getJobParsedPath(jobId: string): string {
  return path.join(PARSED_DIR, `${jobId}.json`);
}

export function getJobExportPath(jobId: string): string {
  return path.join(EXPORTS_DIR, `${jobId}.xlsx`);
}

export async function ensureJobUploadDir(jobId: string): Promise<string> {
  const dir = getJobUploadDir(jobId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveParsedResult(jobId: string, data: unknown): Promise<void> {
  const filePath = getJobParsedPath(jobId);
  await fs.mkdir(PARSED_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function deleteJobFiles(jobId: string): Promise<void> {
  const dir = getJobUploadDir(jobId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}
