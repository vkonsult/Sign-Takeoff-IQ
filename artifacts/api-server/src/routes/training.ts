import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { jobsTable, jobFilesTable, extractedSignsTable } from "@workspace/db";
import { ensureJobUploadDir } from "../lib/storage";
import { ai } from "@workspace/integrations-gemini-ai";
import { extractSignsFromPdf } from "../lib/extraction";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TMP_DIR = "/tmp/sign-takeoff-training";

async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureTmpDir();
      cb(null, TMP_DIR);
    } catch (err) {
      cb(err as Error, TMP_DIR);
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
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = [".pdf", ".xlsx", ".xls", ".csv"];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, XLSX, XLS, or CSV files are allowed"));
    }
  },
});

// ── Column auto-detection ───────────────────────────────────────────────────

type SignField =
  | "sheetNumber"
  | "detailReference"
  | "signIdentifier"
  | "signType"
  | "quantity"
  | "location"
  | "dimensions"
  | "mountingType"
  | "finishColor"
  | "illumination"
  | "materials"
  | "messageContent"
  | "notes"
  | "pageNumber";

const FIELD_KEYWORDS: Record<SignField, string[]> = {
  sheetNumber: ["sheet", "sht", "dwg", "drawing", "sheet #", "sheet no", "sheet number"],
  detailReference: ["detail", "ref", "reference", "callout", "detail ref"],
  signIdentifier: ["sign id", "signid", "sign_id", "identifier", "id", "code", "sign code", "number", "sign number"],
  signType: ["type", "sign type", "category", "sign category", "classification", "class"],
  quantity: ["qty", "quantity", "count", "qnty", "num", "number of", "total"],
  location: ["location", "loc", "room", "space", "area", "placement", "where", "position"],
  dimensions: ["dimension", "dim", "size", "width", "height", "w x h", "wxh", "overall size"],
  mountingType: ["mount", "mounting", "installation", "install", "method", "attach", "fastening"],
  finishColor: ["finish", "color", "colour", "paint", "coating", "surface", "material finish"],
  illumination: ["illuminat", "lighting", "light", "backlit", "lit", "glow", "luminous"],
  materials: ["material", "substrate", "construction", "built", "fabrication", "fabric"],
  messageContent: ["message", "content", "copy", "text", "wording", "inscription", "verbiage"],
  notes: ["note", "comment", "remark", "additional", "misc", "other", "special"],
  pageNumber: ["page", "pg", "page #", "page no"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function detectField(header: string): SignField | null {
  const norm = normalizeHeader(header);
  for (const [field, keywords] of Object.entries(FIELD_KEYWORDS) as [SignField, string[]][]) {
    for (const kw of keywords) {
      if (norm === kw || norm.includes(kw)) {
        return field;
      }
    }
  }
  return null;
}

type ColumnMap = Partial<Record<SignField, number>>;

function buildColumnMap(headers: (string | null | undefined)[]): ColumnMap {
  const map: ColumnMap = {};
  const taken = new Set<SignField>();

  headers.forEach((h, idx) => {
    if (!h) return;
    const field = detectField(String(h));
    if (field && !taken.has(field)) {
      map[field] = idx;
      taken.add(field);
    }
  });
  return map;
}

function cellStr(cell: ExcelJS.Cell): string {
  if (cell.value == null) return "";
  if (typeof cell.value === "object" && "text" in (cell.value as object)) {
    return String((cell.value as { text: string }).text);
  }
  return String(cell.value).trim();
}

// ── Route ───────────────────────────────────────────────────────────────────

router.post(
  "/training",
  (req, res, next) => {
    upload.fields([
      { name: "pdf", maxCount: 1 },
      { name: "xlsx", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message ?? "Upload error" });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const pdfFiles = files?.["pdf"] ?? [];
    const xlsxFiles = files?.["xlsx"] ?? [];

    if (pdfFiles.length === 0) {
      res.status(400).json({ error: "A PDF plan file is required" });
      return;
    }
    if (xlsxFiles.length === 0) {
      res.status(400).json({ error: "An XLSX/XLS sign schedule file is required" });
      return;
    }

    const pdfFile = pdfFiles[0]!;
    const xlsxFile = xlsxFiles[0]!;

    const cleanups: string[] = [pdfFile.path, xlsxFile.path];

    try {
      // ── Parse the XLSX ────────────────────────────────────────────────────
      const workbook = new ExcelJS.Workbook();
      const ext = path.extname(xlsxFile.originalname).toLowerCase();
      if (ext === ".csv") {
        await workbook.csv.readFile(xlsxFile.path);
      } else {
        await workbook.xlsx.readFile(xlsxFile.path);
      }

      const sheet = workbook.worksheets[0];
      if (!sheet) {
        res.status(400).json({ error: "The spreadsheet appears to be empty" });
        return;
      }

      // Find the header row — scan first 10 rows for a row with the most non-empty cells
      let headerRowIdx = 1;
      let bestCount = 0;
      sheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
        if (rowIdx > 10) return;
        let count = 0;
        row.eachCell({ includeEmpty: false }, () => { count++; });
        if (count > bestCount) { bestCount = count; headerRowIdx = rowIdx; }
      });

      const headerRow = sheet.getRow(headerRowIdx);
      const rawHeaders: (string | null)[] = [];
      headerRow.eachCell({ includeEmpty: true }, (cell) => {
        rawHeaders.push(cell.value != null ? cellStr(cell) : null);
      });

      const colMap = buildColumnMap(rawHeaders);
      const mappedFields = Object.keys(colMap) as SignField[];

      if (mappedFields.length === 0) {
        res.status(400).json({
          error: "Could not detect any sign schedule columns. Make sure the spreadsheet has clear column headers (e.g. Sign ID, Sign Type, Location, Dimensions).",
        });
        return;
      }

      // ── Create job ────────────────────────────────────────────────────────
      const jobName = pdfFile.originalname
        .replace(/\.pdf$/i, "")
        .replace(/[_-]+/g, " ")
        .trim();

      const [job] = await db
        .insert(jobsTable)
        .values({
          name: jobName,
          status: "completed",
          fileCount: 1,
          organizationId: req.authUser?.organizationId ?? null,
        })
        .returning();

      const uploadDir = await ensureJobUploadDir(job.id);
      const destPath = path.join(uploadDir, pdfFile.filename);
      await fs.copyFile(pdfFile.path, destPath);

      const [fileRecord] = await db
        .insert(jobFilesTable)
        .values({
          jobId: job.id,
          originalName: pdfFile.originalname,
          storedPath: destPath,
        })
        .returning();

      // ── Parse data rows ───────────────────────────────────────────────────
      type SignInsert = {
        jobId: string;
        jobFileId: string;
        sheetNumber?: string | null;
        detailReference?: string | null;
        signIdentifier?: string | null;
        signType?: string | null;
        quantity?: number | null;
        location?: string | null;
        dimensions?: string | null;
        mountingType?: string | null;
        finishColor?: string | null;
        illumination?: string | null;
        materials?: string | null;
        messageContent?: string | null;
        notes?: string | null;
        pageNumber?: number | null;
        userVerified: boolean;
        manuallyAdded: boolean;
        confidenceScore: number;
        reviewFlag: boolean;
      };

      const signsToInsert: SignInsert[] = [];

      sheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
        if (rowIdx <= headerRowIdx) return;

        const getCol = (field: SignField): string => {
          const colIdx = colMap[field];
          if (colIdx == null) return "";
          const cell = row.getCell(colIdx + 1);
          return cellStr(cell);
        };

        const signId = getCol("signIdentifier");
        const signType = getCol("signType");
        const location = getCol("location");

        if (!signId && !signType && !location) return;

        const qtyStr = getCol("quantity");
        const qty = qtyStr ? parseInt(qtyStr, 10) : null;
        const pgStr = getCol("pageNumber");
        const pg = pgStr ? parseInt(pgStr, 10) : null;

        signsToInsert.push({
          jobId: job.id,
          jobFileId: fileRecord.id,
          sheetNumber: getCol("sheetNumber") || null,
          detailReference: getCol("detailReference") || null,
          signIdentifier: signId || null,
          signType: signType || null,
          quantity: isNaN(qty!) ? null : qty,
          location: location || null,
          dimensions: getCol("dimensions") || null,
          mountingType: getCol("mountingType") || null,
          finishColor: getCol("finishColor") || null,
          illumination: getCol("illumination") || null,
          materials: getCol("materials") || null,
          messageContent: getCol("messageContent") || null,
          notes: getCol("notes") || null,
          pageNumber: isNaN(pg!) ? null : pg,
          userVerified: true,
          manuallyAdded: false,
          confidenceScore: 1.0,
          reviewFlag: false,
        });
      });

      if (signsToInsert.length === 0) {
        res.status(400).json({
          error: "No sign rows found in the spreadsheet. Check that data rows exist below the header row.",
        });
        return;
      }

      // Insert in chunks of 500
      for (let i = 0; i < signsToInsert.length; i += 500) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.insert(extractedSignsTable).values(signsToInsert.slice(i, i + 500) as any);
      }

      // ── Verification extraction: run AI on the training PDF and cross-match ──
      // This shows which schedule signs the AI finds (and where), and which it misses.
      type VerificationMarker = {
        pageNumber: number;
        xPos: number;
        yPos: number;
        signIdentifier: string | null;
        signType: string | null;
        location: string | null;
        status: "matched" | "extra";
      };
      type MissedSign = {
        signIdentifier: string | null;
        signType: string | null;
        location: string | null;
      };

      let verification: {
        extractedCount: number;
        matchedCount: number;
        extraCount: number;
        missedCount: number;
        matchRate: number;
        markers: VerificationMarker[];
        missedSigns: MissedSign[];
      } | null = null;

      try {
        logger.info({ jobId: job.id }, "Running verification extraction on training PDF");
        const { rows: extractedRows } = await extractSignsFromPdf(destPath, ai);

        function normType(t: string | null | undefined): string {
          return (t ?? "").toLowerCase().replace(/[^a-z]/g, "");
        }

        function locationWords(loc: string | null | undefined): string[] {
          return (loc ?? "")
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 2);
        }

        function matchScore(
          extractedType: string | null | undefined,
          extractedLoc: string | null | undefined,
          extractedId: string | null | undefined,
          schedType: string | null | undefined,
          schedLoc: string | null | undefined,
          schedId: string | null | undefined
        ): number {
          let score = 0;
          if (
            extractedId &&
            schedId &&
            extractedId.toUpperCase() === schedId.toUpperCase()
          ) score += 10;
          if (normType(extractedType) === normType(schedType) && normType(extractedType) !== "")
            score += 5;
          const ew = locationWords(extractedLoc);
          const sw = locationWords(schedLoc);
          if (sw.length > 0) {
            const overlap = ew.filter((w) => sw.includes(w)).length;
            score += (overlap / sw.length) * 3;
          }
          return score;
        }

        const MATCH_THRESHOLD = 4;

        // Track which schedule signs have been matched (one-to-one)
        const scheduleMatched = new Array(signsToInsert.length).fill(false);

        const markers: VerificationMarker[] = [];

        for (const row of extractedRows) {
          if (row.xPos == null || row.yPos == null || row.pageNumber == null) continue;

          let bestScore = 0;
          let bestIdx = -1;

          for (let i = 0; i < signsToInsert.length; i++) {
            if (scheduleMatched[i]) continue;
            const s = signsToInsert[i]!;
            const score = matchScore(
              row.signType, row.location, row.signIdentifier,
              s.signType, s.location, s.signIdentifier
            );
            if (score > bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }

          const isMatched = bestScore >= MATCH_THRESHOLD && bestIdx >= 0;
          if (isMatched) scheduleMatched[bestIdx] = true;

          markers.push({
            pageNumber: row.pageNumber,
            xPos: row.xPos,
            yPos: row.yPos,
            signIdentifier: row.signIdentifier ?? null,
            signType: row.signType ?? null,
            location: row.location ?? null,
            status: isMatched ? "matched" : "extra",
          });
        }

        const matchedCount = markers.filter((m) => m.status === "matched").length;
        const extraCount = markers.filter((m) => m.status === "extra").length;

        const missedSigns: MissedSign[] = signsToInsert
          .filter((_, i) => !scheduleMatched[i])
          .map((s) => ({
            signIdentifier: s.signIdentifier ?? null,
            signType: s.signType ?? null,
            location: s.location ?? null,
          }));

        verification = {
          extractedCount: extractedRows.length,
          matchedCount,
          extraCount,
          missedCount: missedSigns.length,
          matchRate: signsToInsert.length > 0 ? matchedCount / signsToInsert.length : 0,
          markers,
          missedSigns: missedSigns.slice(0, 50),
        };

        logger.info(
          { matchedCount, extraCount, missedCount: missedSigns.length },
          "Training verification complete"
        );
      } catch (verifyErr) {
        logger.warn({ verifyErr }, "Verification extraction failed — returning import result only");
      }

      res.status(201).json({
        jobId: job.id,
        fileId: fileRecord.id,
        jobName,
        signCount: signsToInsert.length,
        detectedColumns: mappedFields,
        message: `Successfully imported ${signsToInsert.length} verified signs from training data.`,
        verification,
      });
    } catch (err) {
      req.log.error({ err }, "Training import failed");
      res.status(500).json({ error: "Training import failed", details: String(err) });
    } finally {
      for (const p of cleanups) {
        fs.unlink(p).catch(() => undefined);
      }
    }
  }
);

export default router;
