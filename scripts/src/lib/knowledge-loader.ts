import fs from "fs/promises";
import path from "path";

export const REQUIRED_METADATA_FIELDS = [
  "jurisdiction",
  "doc_type",
  "section",
  "effective_date",
  "status",
] as const;

export type RequiredField = (typeof REQUIRED_METADATA_FIELDS)[number];

export interface KnowledgeMetadata {
  jurisdiction: string;
  doc_type: string;
  section: string;
  effective_date: string;
  status: "active" | "superseded" | "draft" | string;
  [key: string]: string;
}

export interface KnowledgeFile {
  filePath: string;
  relativePath: string;
  metadata: KnowledgeMetadata;
  body: string;
  isValid: boolean;
  validationErrors: string[];
}

export function parseFrontMatter(content: string): {
  metadata: Record<string, string>;
  body: string;
} {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { metadata: {}, body: content.trim() };
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2].trim();
  const metadata: Record<string, string> = {};

  for (const line of yamlStr.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) metadata[key] = value;
  }

  return { metadata, body };
}

export function validateMetadata(
  metadata: Record<string, string>,
  filePath: string
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!metadata[field] || metadata[field].trim() === "") {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (metadata.status && !["active", "superseded", "draft"].includes(metadata.status)) {
    errors.push(
      `Invalid status "${metadata.status}". Must be one of: active, superseded, draft`
    );
  }

  if (metadata.effective_date) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(metadata.effective_date)) {
      errors.push(
        `Invalid effective_date format "${metadata.effective_date}". Expected ISO 8601 (YYYY-MM-DD)`
      );
    }
  }

  if (metadata.doc_type) {
    const validDocTypes = [
      "federal_codes",
      "state_codes",
      "city_codes",
      "sign_glossary",
      "plan_guides",
      "customer_standards",
    ];
    if (!validDocTypes.includes(metadata.doc_type)) {
      errors.push(
        `Invalid doc_type "${metadata.doc_type}". Must be one of: ${validDocTypes.join(", ")}`
      );
    }
  }

  if (errors.length > 0) {
    errors.unshift(`Validation failed for ${filePath}:`);
  }

  return { isValid: errors.length === 0, errors };
}

export async function loadKnowledgeFile(
  filePath: string,
  knowledgeDir: string
): Promise<KnowledgeFile> {
  const content = await fs.readFile(filePath, "utf-8");
  const { metadata, body } = parseFrontMatter(content);
  const relativePath = path.relative(knowledgeDir, filePath);
  const { isValid, errors } = validateMetadata(metadata, relativePath);

  return {
    filePath,
    relativePath,
    metadata: metadata as KnowledgeMetadata,
    body,
    isValid,
    validationErrors: errors,
  };
}

export async function findKnowledgeFiles(
  dir: string,
  extensions = [".md", ".txt"]
): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await findKnowledgeFiles(fullPath, extensions);
        files.push(...subFiles);
      } else if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext)) &&
        entry.name !== "README.md"
      ) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — return empty
  }
  return files;
}
