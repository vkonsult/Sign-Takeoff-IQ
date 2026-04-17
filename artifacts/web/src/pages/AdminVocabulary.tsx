import { useState, useEffect } from "react";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Save, ChevronDown, ChevronRight } from "lucide-react";

const BUILDING_TYPES = [
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

type BuildingType = (typeof BUILDING_TYPES)[number];

type VocabularyOverrides = Record<BuildingType, Record<string, string>>;

interface TermRow {
  token: string;
  signType: string;
  source: "built-in" | "override" | "custom";
}

function mergeVocab(
  base: Record<string, string>,
  overrides: Record<string, string>
): TermRow[] {
  const rows: TermRow[] = [];
  const overrideKeys = new Set(Object.keys(overrides));

  for (const [token, signType] of Object.entries(base)) {
    if (overrideKeys.has(token)) {
      const overrideValue = overrides[token];
      if (overrideValue !== signType) {
        rows.push({ token, signType: overrideValue, source: "override" });
      } else {
        rows.push({ token, signType, source: "built-in" });
      }
      overrideKeys.delete(token);
    } else {
      rows.push({ token, signType, source: "built-in" });
    }
  }

  for (const token of overrideKeys) {
    rows.push({ token, signType: overrides[token], source: "custom" });
  }

  return rows;
}

function rowsToMap(rows: TermRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const t = row.token.trim();
    if (t) result[t] = row.signType.trim();
  }
  return result;
}

interface SectionProps {
  buildingType: BuildingType;
  rows: TermRow[];
  baseVocab: Record<string, string>;
  onChange: (rows: TermRow[]) => void;
}

function computeSource(
  token: string,
  signType: string,
  baseVocab: Record<string, string>
): TermRow["source"] {
  const baseValue = baseVocab[token.trim()];
  if (baseValue === undefined) return "custom";
  if (baseValue === signType.trim()) return "built-in";
  return "override";
}

function VocabSection({ buildingType, rows, baseVocab, onChange }: SectionProps) {
  const [open, setOpen] = useState(true);

  function updateRow(index: number, field: "token" | "signType", value: string) {
    const next = rows.map((r, i) => {
      if (i !== index) return r;
      const updated = { ...r, [field]: value };
      updated.source = computeSource(updated.token, updated.signType, baseVocab);
      return updated;
    });
    onChange(next);
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  function addRow() {
    onChange([...rows, { token: "", signType: "", source: "custom" }]);
  }

  const label = buildingType.charAt(0).toUpperCase() + buildingType.slice(1);
  const builtInCount = rows.filter((r) => r.source === "built-in").length;
  const customCount = rows.filter((r) => r.source !== "built-in").length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 bg-card hover:bg-secondary/50 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}
        <span className="font-medium text-sm">{label}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {builtInCount} built-in
          </Badge>
          {customCount > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-primary border-primary/40">
              +{customCount} custom
            </Badge>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border">
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground text-xs w-5/12">Token</th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground text-xs w-6/12">Sign Type</th>
                  <th className="px-2 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-secondary/20">
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <Input
                          value={row.token}
                          onChange={(e) => updateRow(i, "token", e.target.value)}
                          placeholder="token"
                          className="h-7 text-xs font-mono"
                        />
                        {row.source === "built-in" && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0 text-muted-foreground flex-shrink-0">
                            built-in
                          </Badge>
                        )}
                        {row.source === "override" && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-600 border-amber-400/50 flex-shrink-0">
                            override
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-1.5">
                      <Input
                        value={row.signType}
                        onChange={(e) => updateRow(i, "signType", e.target.value)}
                        placeholder="SIGN TYPE"
                        className="h-7 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                        title="Remove term"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {rows.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground italic">
              No terms for this building type. Add one below.
            </p>
          )}

          <div className="px-4 py-2 border-t border-border/50 bg-secondary/10">
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              Add term
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminVocabulary() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Record<BuildingType, TermRow[]> | null>(null);
  const [baseVocab, setBaseVocab] = useState<Record<BuildingType, Record<string, string>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [baseRes, overridesRes] = await Promise.all([
        apiFetch("/api/vocabulary/base"),
        apiFetch("/api/vocabulary"),
      ]);
      if (!baseRes.ok) throw new Error("Failed to load base vocabulary");
      if (!overridesRes.ok) throw new Error("Failed to load vocabulary overrides");

      const baseData = (await baseRes.json()) as Record<BuildingType, Record<string, string>>;
      const overridesData = (await overridesRes.json()) as VocabularyOverrides;

      setBaseVocab(baseData);
      const initialRows = {} as Record<BuildingType, TermRow[]>;
      for (const bt of BUILDING_TYPES) {
        initialRows[bt] = mergeVocab(baseData[bt] ?? {}, overridesData[bt] ?? {});
      }
      setRows(initialRows);
    } catch {
      toast({ title: "Error", description: "Could not load vocabulary.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!rows) return;
    setSaving(true);
    try {
      const payload: VocabularyOverrides = {} as VocabularyOverrides;
      for (const bt of BUILDING_TYPES) {
        payload[bt] = rowsToMap(rows[bt] ?? []);
      }
      const res = await apiFetch("/api/vocabulary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Save failed");
      }
      toast({ title: "Saved", description: "Vocabulary updated." });
    } catch (e) {
      toast({
        title: "Error saving",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function updateSection(bt: BuildingType, newRows: TermRow[]) {
    setRows((prev) => (prev ? { ...prev, [bt]: newRows } : prev));
  }

  const totalTerms = rows
    ? BUILDING_TYPES.reduce((sum, bt) => sum + (rows[bt]?.length ?? 0), 0)
    : 0;
  const builtInTerms = rows
    ? BUILDING_TYPES.reduce(
        (sum, bt) => sum + (rows[bt]?.filter((r) => r.source === "built-in").length ?? 0),
        0
      )
    : 0;
  const customTerms = totalTerms - builtInTerms;

  return (
    <AdminShell section="super">
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Vocabulary Editor</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              View and edit the full sign vocabulary per building type — built-in defaults plus your customizations.{" "}
              <span className="text-muted-foreground font-medium">Built-in</span> rows come from the static dictionary;{" "}
              <span className="text-amber-600 font-medium">override</span> rows replace a built-in value.
            </p>
          </div>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || loading || !rows}
            size="sm"
            className="gap-2"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {loading && (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              Loading vocabulary…
            </div>
          )}

          {!loading && rows && (
            <div className="space-y-3 max-w-4xl">
              <p className="text-xs text-muted-foreground">
                {totalTerms} {totalTerms === 1 ? "term" : "terms"} across all building types
                {customTerms > 0
                  ? ` — ${builtInTerms} built-in, ${customTerms} custom`
                  : " (all built-in)"}.
              </p>
              {BUILDING_TYPES.map((bt) => (
                <VocabSection
                  key={bt}
                  buildingType={bt}
                  rows={rows[bt] ?? []}
                  baseVocab={baseVocab?.[bt] ?? {}}
                  onChange={(newRows) => updateSection(bt, newRows)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
