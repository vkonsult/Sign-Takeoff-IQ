import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { db } from "@workspace/db";
import { jobsTable, jobFilesTable } from "@workspace/db";
import { ensureJobUploadDir } from "../lib/storage";
import { processJob } from "../lib/process-job";
import { processJobHeuristic } from "../lib/process-job-heuristic";
import { invalidatePdfCaches } from "../lib/pdf-words";
import { watchPdfFile } from "../lib/pdf-file-watcher";

const router: IRouter = Router();

const TMP_UPLOAD_DIR = "/tmp/sign-takeoff-uploads";

async function ensureTmpDir(): Promise<void> {
  await fs.mkdir(TMP_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureTmpDir();
      cb(null, TMP_UPLOAD_DIR);
    } catch (err) {
      cb(err as Error, TMP_UPLOAD_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${Date.now()}-${safe}${ext}`);
  },
});

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

router.post("/upload", (req, res, next) => {
  upload.array("files", 20)(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: `File too large. Maximum allowed size is ${MAX_FILE_SIZE / (1024 * 1024)} MB per file.`,
        });
      } else {
        res.status(400).json({ error: err.message ?? "Upload error" });
      }
      return;
    }
    next();
  });
}, async (req, res) => {
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ error: "No PDF files uploaded" });
    return;
  }

  const orgId = req.authUser?.organizationId ?? null;
  if (!orgId && !req.authUser?.isSuperAdmin) {
    res.status(403).json({ error: "No organization context. Please contact your administrator." });
    return;
  }

  try {
    const firstName = files[0]?.originalname ?? "Untitled Job";
    const jobName = firstName.replace(/\.pdf$/i, "").replace(/[_-]/g, " ").trim();

    // Optional form field: "method" = "gemini" (default) | "heuristic"
    const scanMethod = req.body?.method === "heuristic" ? "heuristic" : "gemini";

    const [job] = await db
      .insert(jobsTable)
      .values({
        name: jobName,
        status: "pending",
        fileCount: files.length,
        organizationId: orgId,
        scanMethod,
      })
      .returning();

    const uploadDir = await ensureJobUploadDir(job.id);

    const fileRecords = await Promise.all(
      files.map(async (file) => {
        const destPath = path.join(uploadDir, file.filename);
        await fs.copyFile(file.path, destPath);
        await fs.unlink(file.path).catch(() => undefined);
        return {
          jobId: job.id,
          originalName: file.originalname,
          storedPath: destPath,
        };
      })
    );

    const insertedFiles = await db.insert(jobFilesTable).values(fileRecords).returning();

    // Evict any stale cache entries for these paths/IDs so that if a file was
    // previously cached (e.g. a re-upload overwriting the same stored path)
    // the next extraction reads fresh data from disk.
    for (const record of insertedFiles) {
      invalidatePdfCaches(record.storedPath, record.id);
      // Register a file-system watcher so that any future out-of-band replacement
      // of this file on disk (e.g. by a sysadmin script) also invalidates the caches.
      watchPdfFile(record.storedPath, record.id);
    }

    req.log.info({ jobId: job.id, fileCount: files.length, scanMethod }, "Upload complete, auto-starting extraction");

    res.status(201).json({
      jobId: job.id,
      fileCount: files.length,
      message: `Successfully uploaded ${files.length} file(s). Extraction starting automatically.`,
    });

    if (scanMethod === "heuristic") {
      processJobHeuristic(job.id).catch((err) => {
        req.log.error({ err, jobId: job.id }, "Auto-triggered heuristic extraction failed");
      });
    } else {
      processJob(job.id).catch((err) => {
        req.log.error({ err, jobId: job.id }, "Auto-triggered extraction failed");
      });
    }
  } catch (err) {
    req.log.error({ err }, "Upload failed");
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

export default router;
