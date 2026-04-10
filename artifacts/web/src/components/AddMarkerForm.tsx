import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/apiClient";
import { MapPin, Loader2 } from "lucide-react";

const SIGN_TYPES = [
  "Room ID",
  "ADA / Accessibility",
  "Wayfinding",
  "Directional",
  "Informational",
  "Regulatory",
  "Safety",
  "Exit",
  "Building ID",
  "Monument",
  "Pylon",
  "Parking",
  "Restroom",
  "Channel Letter",
  "Cabinet",
  "Dimensional Letter",
  "Building Sign",
];

export interface PendingMarker {
  xPos: number;
  yPos: number;
  pageNumber: number;
  jobFileId: string;
  jobId: string;
}

interface Props {
  pending: PendingMarker;
  onSave: (sign: unknown) => void;
  onCancel: () => void;
}

export function AddMarkerForm({ pending, onSave, onCancel }: Props) {
  const [location, setLocation] = useState("");
  const [signType, setSignType] = useState("");
  const [signIdentifier, setSignIdentifier] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [adaRequired, setAdaRequired] = useState(false);
  const [messageContent, setMessageContent] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !!(location.trim() || signType.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/extracted-signs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: pending.jobId,
          jobFileId: pending.jobFileId,
          pageNumber: pending.pageNumber,
          xPos: pending.xPos,
          yPos: pending.yPos,
          location: location.trim() || null,
          signType: signType || null,
          signIdentifier: signIdentifier.trim() || null,
          quantity: quantity || 1,
          adaRequired,
          messageContent: messageContent.trim() || null,
          notes: notes.trim() || null,
          placementSource: "manual",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(text);
      }
      const data = (await res.json()) as { sign: unknown };
      onSave(data.sign);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save sign");
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent className="max-w-sm border-border bg-background p-5">
        <DialogHeader className="mb-1">
          <DialogTitle className="flex items-center gap-2 text-sm font-display text-foreground">
            <MapPin className="w-4 h-4 text-primary flex-shrink-0" />
            Add Sign at This Location
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">
              Location / Room Name
              <span className="text-primary ml-0.5">*</span>
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Art 108, Music 105, PreK 125"
              className="w-full px-3 py-1.5 rounded-md border border-border bg-secondary/50 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Sign Type
              </label>
              <select
                value={signType}
                onChange={(e) => setSignType(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-secondary/50 text-sm text-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
              >
                <option value="">Select…</option>
                {SIGN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Sign ID
              </label>
              <input
                type="text"
                value={signIdentifier}
                onChange={(e) => setSignIdentifier(e.target.value)}
                placeholder="e.g. RI-108"
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-secondary/50 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Quantity
              </label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) =>
                  setQuantity(Math.max(1, parseInt(e.target.value) || 1))
                }
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-secondary/50 text-sm text-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Message / Copy
              </label>
              <input
                type="text"
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                placeholder="Text on sign"
                className="w-full px-2.5 py-1.5 rounded-md border border-border bg-secondary/50 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="ada-required"
              type="checkbox"
              checked={adaRequired}
              onChange={(e) => setAdaRequired(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-secondary/50 text-primary accent-primary cursor-pointer"
            />
            <label
              htmlFor="ada-required"
              className="text-sm text-foreground cursor-pointer select-none"
            >
              ADA Required
            </label>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes…"
              rows={2}
              className="w-full px-3 py-1.5 rounded-md border border-border bg-secondary/50 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 resize-none"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-2 py-1 rounded">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="flex-1 px-3 py-1.5 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || saving}
              className="flex-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-display font-semibold uppercase tracking-wide hover:bg-primary/90 transition-all disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save Sign
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
