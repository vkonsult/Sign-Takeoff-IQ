import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { db, jobFilesTable, jobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middlewares/authMiddleware";
import { invalidatePdfCaches } from "../lib/pdf-words";
import { watchPdfFile } from "../lib/pdf-file-watcher";

const router: IRouter = Router();

const TMP_REPLACE_DIR = "/tmp/sign-takeoff-replace";

async function ensureTmpDir(): Promise<void> {
  await fs.mkdir(TMP_REPLACE_DIR, { recursive: true });
}

const replaceStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureTmpDir();
      cb(null, TMP_REPLACE_DIR);
    } catch (err) {
      cb(err as Error, TMP_REPLACE_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${Date.now()}-${safe}${ext}`);
  },
});

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const uploadSingle = multer({
  storage: replaceStorage,
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

router.patch(
  "/files/:fileId/replace",
  requireRole("ADMIN"),
  (req, res, next) => {
    uploadSingle.single("file")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `File too large. Maximum allowed size is ${MAX_FILE_SIZE / (1024 * 1024)} MB.`,
          });
        } else {
          res.status(400).json({ error: err.message ?? "Upload error" });
        }
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const { fileId } = req.params as Record<string, string>;
    const uploaded = req.file as Express.Multer.File | undefined;

    if (!uploaded) {
      res.status(400).json({ error: "No PDF file provided" });
      return;
    }

    try {
      const [fileRecord] = await db
        .select({
          id: jobFilesTable.id,
          storedPath: jobFilesTable.storedPath,
          originalName: jobFilesTable.originalName,
          jobId: jobFilesTable.jobId,
          organizationId: jobsTable.organizationId,
        })
        .from(jobFilesTable)
        .innerJoin(jobsTable, eq(jobFilesTable.jobId, jobsTable.id))
        .where(eq(jobFilesTable.id, fileId))
        .limit(1);

      if (!fileRecord) {
        await fs.unlink(uploaded.path).catch(() => undefined);
        res.status(404).json({ error: "File not found" });
        return;
      }

      const callerOrgId = req.authUser?.organizationId;
      const isSuperAdmin = req.authUser?.isSuperAdmin ?? false;

      if (!isSuperAdmin && fileRecord.organizationId !== callerOrgId) {
        await fs.unlink(uploaded.path).catch(() => undefined);
        res.status(403).json({ error: "Forbidden — file belongs to a different organization" });
        return;
      }

      await fs.copyFile(uploaded.path, fileRecord.storedPath);
      await fs.unlink(uploaded.path).catch(() => undefined);

      invalidatePdfCaches(fileRecord.storedPath, fileRecord.id);
      watchPdfFile(fileRecord.storedPath, fileRecord.id);

      req.log.info(
        { fileId, storedPath: fileRecord.storedPath, jobId: fileRecord.jobId },
        "PDF file replaced successfully",
      );

      res.json({
        fileId: fileRecord.id,
        jobId: fileRecord.jobId,
        storedPath: fileRecord.storedPath,
        message: "File replaced successfully. Caches invalidated.",
      });
    } catch (err) {
      await fs.unlink(uploaded.path).catch(() => undefined);
      req.log.error({ err, fileId }, "Failed to replace file");
      res.status(500).json({ error: "Failed to replace file", details: String(err) });
    }
  },
);

export default router;
