import { useState, useEffect } from "react";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Save, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

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

const STATIC_TOKENS = new Set([
  "wrr","womens","women's","women","girls",
  "mrr","mens","men's","men","boys",
  "corridor","corr","hallway","hall",
  "lobby","reception","foyer","entry","entrance","vestibule","narthex",
  "mech","mechanical","elec","electrical",
  "stair","stairwell","stairs","elev","elevator","lift",
  "restroom","toilet","wc","lavatory","bathroom",
  "office","conference","collab","collaboration","meeting",
  "classroom","training","storage","stor","closet",
  "sanctuary","chapel","worship","fellowship","commons","community","multipurpose",
  "sacristy","vestry","clergy","console",
  "server","data","telecom","idf","mdf",
  "janitor","custodial","housekeeping",
  "break","lounge","kitchen","café","cafe","breakroom",
]);

interface TermRow {
  token: string;
  signType: string;
}

function buildTypeRows(map: Record<string, string>): TermRow[] {
  return Object.entries(map).map(([token, signType]) => ({ token, signType }));
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
  onChange: (rows: TermRow[]) => void;
}

function VocabSection({ buildingType, rows, onChange }: SectionProps) {
  const [open, setOpen] = useState(true);

  function updateRow(index: number, field: keyof TermRow, value: string) {
    const next = rows.map((r, i) => (i === index ? { ...r, [field]: value } : r));
    onChange(next);
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  function addRow() {
    onChange([...rows, { token: "", signType: "" }]);
  }

  const label = buildingType.charAt(0).toUpperCase() + buildingType.slice(1);

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
        <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
          {rows.length} {rows.length === 1 ? "term" : "terms"}
        </Badge>
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
                {rows.map((row, i) => {
                  const isCustomOverride = STATIC_TOKENS.has(row.token.toLowerCase().trim());
                  return (
                    <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-secondary/20">
                      <td className="px-4 py-1.5">
                        <div className="flex items-center gap-2">
                          <Input
                            value={row.token}
                            onChange={(e) => updateRow(i, "token", e.target.value)}
                            placeholder="token"
                            className="h-7 text-xs font-mono"
                          />
                          {isCustomOverride && (
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
                  );
                })}
              </tbody>
            </table>
          )}

          {rows.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground italic">
              No custom terms for this building type. Add one below.
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
  const [overrides, setOverrides] = useState<VocabularyOverrides | null>(null);
  const [rows, setRows] = useState<Record<BuildingType, TermRow[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch("/api/vocabulary");
      if (!res.ok) throw new Error("Failed to load vocabulary");
      const data = (await res.json()) as VocabularyOverrides;
      setOverrides(data);
      const initialRows = {} as Record<BuildingType, TermRow[]>;
      for (const bt of BUILDING_TYPES) {
        initialRows[bt] = buildTypeRows(data[bt] ?? {});
      }
      setRows(initialRows);
    } catch {
      toast({ title: "Error", description: "Could not load vocabulary overrides.", variant: "destructive" });
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
      setOverrides(payload);
      toast({ title: "Saved", description: "Vocabulary overrides updated." });
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

  return (
    <AdminShell section="super">
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Vocabulary Editor</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Manage room-label token → sign-type overrides per building type.{" "}
              <span className="text-amber-600 font-medium">Override</span> badges indicate tokens that also exist in the static vocabulary.
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
                {totalTerms} custom {totalTerms === 1 ? "term" : "terms"} across all building types.
                The static base vocabulary ({new Set(STATIC_TOKENS).size} terms) always applies in addition to these.
              </p>
              {BUILDING_TYPES.map((bt) => (
                <VocabSection
                  key={bt}
                  buildingType={bt}
                  rows={rows[bt] ?? []}
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
