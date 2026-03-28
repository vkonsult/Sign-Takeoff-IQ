/**
 * Validate knowledge files in all (or a specific) collection directory.
 * Checks required YAML front-matter fields and value constraints.
 * Exits with code 1 if any files fail validation (CI-friendly).
 *
 * Usage:
 *   pnpm run validate-knowledge                # Validate all collections
 *   pnpm run validate-knowledge federal_codes  # Validate a single collection
 *
 * TODO (future enhancements):
 *   - JSON Schema or zod-based front-matter validation for richer type checking
 *   - Cross-file checks: detect duplicate section references within a collection
 *   - Auto-suggest effective_date from git log when field is missing
 *   - Integration with pre-commit hook (lint-staged) to validate on git commit
 */

import path from "path";
import { fileURLToPath } from "url";
import { findKnowledgeFiles, loadKnowledgeFile } from "./lib/knowledge-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const KNOWLEDGE_DIR = path.join(WORKSPACE_ROOT, "knowledge");

const COLLECTION_DIRS = [
  "federal_codes",
  "state_codes",
  "city_codes",
  "sign_glossary",
  "plan_guides",
  "customer_standards",
];

async function main() {
  const args = process.argv.slice(2);
  const targetDir = args[0];

  const dirsToCheck = targetDir ? [targetDir] : COLLECTION_DIRS;

  console.log(`\nValidating knowledge files in: ${KNOWLEDGE_DIR}\n`);
  console.log("=".repeat(60));

  let totalFiles = 0;
  let validFiles = 0;
  let invalidFiles = 0;
  const allErrors: Array<{ file: string; errors: string[] }> = [];

  for (const dir of dirsToCheck) {
    const dirPath = path.join(KNOWLEDGE_DIR, dir);
    const files = await findKnowledgeFiles(dirPath);

    if (files.length === 0) {
      console.log(`\n📁 ${dir}/  (no content files found — add .md or .txt files)`);
      continue;
    }

    console.log(`\n📁 ${dir}/`);

    for (const filePath of files) {
      totalFiles++;
      const kf = await loadKnowledgeFile(filePath, KNOWLEDGE_DIR);

      if (kf.isValid) {
        validFiles++;
        console.log(
          `  ✓ ${kf.relativePath} — ${kf.metadata.jurisdiction} | ${kf.metadata.section} | ${kf.metadata.status}`
        );
      } else {
        invalidFiles++;
        console.log(`  ✗ ${kf.relativePath}`);
        for (const err of kf.validationErrors) {
          console.log(`      • ${err}`);
        }
        allErrors.push({ file: kf.relativePath, errors: kf.validationErrors });
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`\nValidation Summary:`);
  console.log(`  Total files checked : ${totalFiles}`);
  console.log(`  Valid               : ${validFiles}`);
  console.log(`  Invalid             : ${invalidFiles}`);

  if (invalidFiles > 0) {
    console.log(
      `\n⚠  ${invalidFiles} file(s) have validation errors. Fix them before ingesting.\n`
    );
    process.exit(1);
  } else if (totalFiles === 0) {
    console.log(`\nℹ  No content files found. Add .md files to knowledge directories to get started.\n`);
  } else {
    console.log(`\n✓ All ${validFiles} files are valid and ready for ingestion.\n`);
  }
}

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
