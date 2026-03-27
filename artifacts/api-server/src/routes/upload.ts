import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { db } from "@workspace/db";
import { jobsTable, jobFilesTable } from "@workspace/db";
import { ensureJobUploadDir } from "../lib/storage";

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

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
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

router.post("/upload", upload.array("files", 20), async (req, res) => {
  const files = req.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    res.status(400).json({ error: "No PDF files uploaded" });
    return;
  }

  try {
    const [job] = await db
      .insert(jobsTable)
      .values({ status: "pending", fileCount: files.length })
      .returning();

    const uploadDir = await ensureJobUploadDir(job.id);

    const fileRecords = await Promise.all(
      files.map(async (file) => {
        const destPath = path.join(uploadDir, file.filename);
        await fs.rename(file.path, destPath);
        return {
          jobId: job.id,
          originalName: file.originalname,
          storedPath: destPath,
        };
      })
    );

    await db.insert(jobFilesTable).values(fileRecords);

    req.log.info({ jobId: job.id, fileCount: files.length }, "Upload complete, job created");

    res.status(201).json({
      jobId: job.id,
      fileCount: files.length,
      message: `Successfully uploaded ${files.length} file(s). Use POST /api/jobs/${job.id}/process to start extraction.`,
    });
  } catch (err) {
    req.log.error({ err }, "Upload failed");
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

export default router;
