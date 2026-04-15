import { useState, useCallback } from "react";
import { FileText, ExternalLink } from "lucide-react";
import type { ExtractedSign } from "@/types/sign";
import type { FileInfo } from "@/components/UnifiedPlanViewer";

interface SignSpecsTabProps {
  /** Non-hidden extracted signs — caller is responsible for filtering hidden signs out. */
  signs: ExtractedSign[];
  files: FileInfo[];
  jobId: string;
}

function getImageUrl(jobId: string, fileId: string, pageNumber: number): string {
  return `/api/jobs/${jobId}/files/${fileId}/pages/${pageNumber}/image`;
}

interface BboxThumbnailProps {
  src: string;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  fullPageHref: string;
}

const THUMB_W = 96;
const THUMB_H = 72;

function BboxThumbnail({ src, bboxX, bboxY, bboxW, bboxH, fullPageHref }: BboxThumbnailProps) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  // Scale image so the bbox width fills the thumbnail container width
  const displayW = THUMB_W / bboxW;
  const displayH = naturalSize
    ? displayW * (naturalSize.h / naturalSize.w)
    : displayW;

  const left = -bboxX * displayW;
  const top = -bboxY * displayH;

  return (
    <a
      href={fullPageHref}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block flex-shrink-0"
      style={{ width: THUMB_W, height: THUMB_H }}
      title="Open full page in new tab"
    >
      <div
        className="overflow-hidden rounded border border-border/60 bg-secondary/30"
        style={{ width: THUMB_W, height: THUMB_H, position: "relative" }}
      >
        <img
          src={src}
          alt="Sign thumbnail"
          onLoad={handleLoad}
          style={{
            position: "absolute",
            width: displayW,
            height: naturalSize ? displayH : "auto",
            left,
            top,
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      </div>
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 rounded">
        <ExternalLink className="w-4 h-4 text-white" />
      </div>
    </a>
  );
}

/** Build sign-identifier-keyed groups, preserving natural sign order within each group. */
function groupBySignId(signs: ExtractedSign[]): Map<string, ExtractedSign[]> {
  const map = new Map<string, ExtractedSign[]>();
  for (const sign of signs) {
    const key = sign.signIdentifier || sign.signType || sign.id;
    const arr = map.get(key);
    if (arr) {
      arr.push(sign);
    } else {
      map.set(key, [sign]);
    }
  }
  return map;
}

function Cell({ value, className }: { value: string | number | null | undefined; className?: string }) {
  return (
    <td
      className={`px-3 py-2.5 text-sm text-foreground/80 align-top border-b border-border/40 ${className ?? ""}`}
      title={typeof value === "string" ? value : undefined}
    >
      {value != null && value !== "" ? value : "—"}
    </td>
  );
}

export function SignSpecsTab({ signs, files, jobId }: SignSpecsTabProps) {
  if (signs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-12">
        <div className="w-16 h-16 rounded-full bg-secondary/60 flex items-center justify-center">
          <FileText className="w-8 h-8 text-muted-foreground/50" />
        </div>
        <div>
          <p className="text-base font-display font-semibold text-foreground/70">No sign spec data available</p>
          <p className="text-sm text-muted-foreground mt-1">
            Run an extraction first, or check that this job has sign schedule pages.
          </p>
        </div>
      </div>
    );
  }

  const fileById = new Map(files.map((f) => [f.id, f]));

  const grouped = groupBySignId(signs);
  const sortedKeys = [...grouped.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  return (
    <div className="flex-1 overflow-auto bg-card border-t border-border">
      <div className="min-w-[max-content] inline-block align-top w-full">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-10 bg-secondary/90 backdrop-blur-sm">
            <tr>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border w-28">
                Image
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Sign ID
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Sign Type
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border w-16 text-center">
                Qty
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Dimensions
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Mounting
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Materials
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Finish / Color
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Illumination
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Message Content
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Sheet
              </th>
              <th className="px-3 py-2.5 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Notes
              </th>
            </tr>
          </thead>
          <tbody className="bg-background">
            {sortedKeys.map((groupKey, gIdx) => {
              const groupSigns = grouped.get(groupKey)!;
              return groupSigns.map((sign, sIdx) => {
                const isFirstInGroup = sIdx === 0;
                const isEven = gIdx % 2 === 0;

                const hasBbox =
                  sign.aiBbox === true &&
                  sign.aiBboxX != null &&
                  sign.aiBboxY != null &&
                  sign.aiBboxW != null &&
                  sign.aiBboxH != null &&
                  sign.aiBboxW > 0 &&
                  sign.aiBboxH > 0;

                const fileId = sign.jobFileId ?? null;
                const pageNum = sign.pageNumber ?? null;
                const file = fileId ? fileById.get(fileId) : undefined;

                // Only render an image when bbox data is present — no page thumbnails.
                // Rows without bbox data show an empty cell (no image).
                const thumbnailCell = hasBbox && fileId && pageNum != null ? (
                  <td className="px-3 py-2.5 border-b border-border/40 w-28 align-top">
                    <BboxThumbnail
                      src={getImageUrl(jobId, fileId, pageNum)}
                      bboxX={sign.aiBboxX!}
                      bboxY={sign.aiBboxY!}
                      bboxW={sign.aiBboxW!}
                      bboxH={sign.aiBboxH!}
                      fullPageHref={getImageUrl(jobId, fileId, pageNum)}
                    />
                  </td>
                ) : (
                  <td className="px-3 py-2.5 border-b border-border/40 w-28 align-top" />
                );

                const rowBg = isEven ? "" : "bg-card/30";
                const groupDivider =
                  isFirstInGroup && gIdx > 0 ? "border-t-2 border-border/60" : "";

                return (
                  <tr
                    key={sign.id}
                    className={`hover:bg-secondary/30 transition-colors ${rowBg} ${groupDivider}`}
                  >
                    {thumbnailCell}
                    <td
                      className={`px-3 py-2.5 border-b border-border/40 align-top ${groupDivider}`}
                    >
                      <span className="font-mono text-sm font-semibold text-foreground">
                        {sign.signIdentifier || "—"}
                      </span>
                      {pageNum != null && (
                        <div className="text-[10px] font-mono mt-0.5 text-muted-foreground">
                          pg {pageNum}
                          {file && (
                            <span className="ml-1 opacity-60">{file.originalName}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <Cell value={sign.signType} />
                    <td className="px-3 py-2.5 border-b border-border/40 text-center font-mono text-sm align-top">
                      {sign.quantity ?? 1}
                    </td>
                    <Cell value={sign.dimensions} className="font-mono text-xs" />
                    <Cell value={sign.mountingType} />
                    <Cell value={sign.materials} />
                    <Cell value={sign.finishColor} />
                    <Cell value={sign.illumination} />
                    <td
                      className="px-3 py-2.5 text-sm text-foreground/80 align-top border-b border-border/40 max-w-[220px]"
                      title={sign.messageContent ?? undefined}
                    >
                      <div className="truncate max-w-[220px]">
                        {sign.messageContent || "—"}
                      </div>
                    </td>
                    <Cell value={sign.sheetNumber} className="font-mono text-xs" />
                    <td
                      className="px-3 py-2.5 text-sm text-foreground/80 align-top border-b border-border/40 max-w-[200px]"
                      title={sign.notes ?? undefined}
                    >
                      <div className="truncate max-w-[200px]">{sign.notes || "—"}</div>
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
