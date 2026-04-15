import { Router, type IRouter } from "express";
import { requireRole } from "../middlewares/authMiddleware";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod/v4";

const router: IRouter = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VOCABULARY_FILE = path.resolve(
  __dirname,
  "../data/vocabulary-overrides.json"
);

export const BUILDING_TYPES = [
  "school",
  "hotel",
  "apartment",
  "office",
  "church",
  "lab",
  "library",
  "sports",
  "generic",
] as const;

export type BuildingType = (typeof BUILDING_TYPES)[number];

const tokenMapSchema = z.record(z.string(), z.string());

const vocabularySchema = z.object({
  school: tokenMapSchema,
  hotel: tokenMapSchema,
  apartment: tokenMapSchema,
  office: tokenMapSchema,
  church: tokenMapSchema,
  lab: tokenMapSchema,
  library: tokenMapSchema,
  sports: tokenMapSchema,
  generic: tokenMapSchema,
});

export type VocabularyOverrides = z.infer<typeof vocabularySchema>;

export function readVocabularyOverrides(): VocabularyOverrides {
  try {
    const raw = fs.readFileSync(VOCABULARY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = vocabularySchema.safeParse(parsed);
    if (!result.success) {
      return {
        school: {},
        hotel: {},
        apartment: {},
        office: {},
        church: {},
        lab: {},
        library: {},
        sports: {},
        generic: {},
      };
    }
    return result.data;
  } catch {
    return {
      school: {},
      hotel: {},
      apartment: {},
      office: {},
      church: {},
      lab: {},
      library: {},
      sports: {},
      generic: {},
    };
  }
}

function writeVocabularyOverrides(data: VocabularyOverrides): void {
  const tmp = VOCABULARY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, VOCABULARY_FILE);
}

router.get("/vocabulary", requireRole("SUPER_ADMIN"), (_req, res) => {
  const data = readVocabularyOverrides();
  res.json(data);
});

router.put("/vocabulary", requireRole("SUPER_ADMIN"), (req, res) => {
  const result = vocabularySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid vocabulary shape", issues: result.error.issues });
    return;
  }
  writeVocabularyOverrides(result.data);
  res.json({ ok: true });
});

export default router;
