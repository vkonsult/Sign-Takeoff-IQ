import { useState, useCallback, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/apiClient";
import { Brain, Play, Loader2, CheckCircle2, AlertTriangle, Info, Cpu, Eye, EyeOff, ChevronDown, ChevronRight, BookOpen, Users, Pencil, Trash2, Plus, Check, X, Lock, LockOpen } from "lucide-react";

export interface AiCallDescriptor {
  type: string;
  name: string;
  description: string;
  prompt: string;
}

interface AiScanResult {
  success: boolean;
  newSignsCreated: number;
  signsUpdated: number;
  details: Record<string, unknown>;
  successfulCallTypes?: string[];
  error?: string;
}

interface CallState {
  status: "idle" | "running" | "success" | "error";
  result?: AiScanResult;
}

interface PlaqueRow {
  id: string;
  typeId: string;
  name: string | null;
  braille: boolean | null;
  letterHeight: string | null;
  trigger: string | null;
  insert: boolean | null;
  insertSize: string | null;
  manuallyEdited: boolean | null;
}

interface OccupantLoadRow {
  id: string;
  roomNum: string;
  roomName: string | null;
  occupantLoad: number | null;
  occupancyGroup: string | null;
  manuallyEdited: boolean | null;
}

const CALL_TYPE_ICONS: Record<string, React.ReactNode> = {
  sign_schedule_enrich: <Eye className="w-4 h-4 text-emerald-400" />,
  project_info: <Info className="w-4 h-4 text-blue-400" />,
  floor_plan_text: <Cpu className="w-4 h-4 text-violet-400" />,
  vision_fallback: <Eye className="w-4 h-4 text-orange-400" />,
  bbox_detection: <Eye className="w-4 h-4 text-orange-400" />,
  title_block_vision: <Eye className="w-4 h-4 text-amber-400" />,
};

export function AiScansTab({
  jobId,
  showAiHighlight,
  onToggleAiHighlight,
  onScansComplete,
}: {
  jobId: string;
  showAiHighlight: boolean;
  onToggleAiHighlight: () => void;
  onScansComplete: () => void;
}) {
  const [callRegistry, setCallRegistry] = useState<AiCallDescriptor[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const [callStates, setCallStates] = useState<Record<string, CallState>>({});
  const [completedCallTypes, setCompletedCallTypes] = useState<Set<string>>(new Set());
  const [runAllState, setRunAllState] = useState<"idle" | "running" | "done">("idle");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());

  // Plaque Schedule state
  const [plaqueStatus, setPlaqueStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [plaqueError, setPlaqueError] = useState<string | null>(null);
  const [plaqueLoadError, setPlaqueLoadError] = useState<string | null>(null);
  const [plaqueRows, setPlaqueRows] = useState<PlaqueRow[]>([]);
  const [plaqueLoading, setPlaqueLoading] = useState(true);

  // Occupant Loads state
  const [occupantStatus, setOccupantStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [occupantError, setOccupantError] = useState<string | null>(null);
  const [occupantLoadError, setOccupantLoadError] = useState<string | null>(null);
  const [occupantRows, setOccupantRows] = useState<OccupantLoadRow[]>([]);
  const [occupantLoading, setOccupantLoading] = useState(true);

  // Plaque Schedule inline-editing state
  const [plaqueEditingId, setPlaqueEditingId] = useState<string | null>(null);
  const [plaqueEditDraft, setPlaqueEditDraft] = useState<{ typeId: string; name: string; braille: string; letterHeight: string; trigger: string }>({ typeId: "", name: "", braille: "", letterHeight: "", trigger: "" });
  const [plaqueEditSaving, setPlaqueEditSaving] = useState(false);
  const [plaqueEditError, setPlaqueEditError] = useState<string | null>(null);
  const [plaqueDeletingId, setPlaqueDeletingId] = useState<string | null>(null);
  const [plaqueUnlockingId, setPlaqueUnlockingId] = useState<string | null>(null);
  const [plaqueUnlockingAll, setPlaqueUnlockingAll] = useState(false);
  const [plaqueConfirmDeleteId, setPlaqueConfirmDeleteId] = useState<string | null>(null);
  const [showPlaqueConfirm, setShowPlaqueConfirm] = useState(false);
  const plaqueConfirmRef = useRef<HTMLTableRowElement | null>(null);
  const [showOccupantConfirm, setShowOccupantConfirm] = useState(false);
  const [confirmRunOneType, setConfirmRunOneType] = useState<string | null>(null);

  // Occupant Loads inline-editing state
  // editingId: id of the row being edited, or "__new__" for a new unsaved row
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ roomNum: string; roomName: string; occupantLoad: string; occupancyGroup: string }>({ roomNum: "", roomName: "", occupantLoad: "", occupancyGroup: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const [unlockingAll, setUnlockingAll] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmDeleteId(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmDeleteId(null);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [confirmDeleteId]);

  useEffect(() => {
    if (!plaqueConfirmDeleteId) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (plaqueConfirmRef.current && !plaqueConfirmRef.current.contains(e.target as Node)) {
        setPlaqueConfirmDeleteId(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlaqueConfirmDeleteId(null);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [plaqueConfirmDeleteId]);

  useEffect(() => {
    if (!showPlaqueConfirm) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPlaqueConfirm(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showPlaqueConfirm]);

  useEffect(() => {
    if (!showOccupantConfirm) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowOccupantConfirm(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showOccupantConfirm]);

  useEffect(() => {
    if (!confirmRunOneType) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmRunOneType(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [confirmRunOneType]);

  useEffect(() => {
    setRegistryLoading(true);
    apiFetch(`/api/jobs/${jobId}/ai-calls`)
      .then((res) => res.json())
      .then((data: { callTypes: AiCallDescriptor[]; completedCallTypes?: string[] }) => {
        const registry = data.callTypes ?? [];
        setCallRegistry(registry);
        setRegistryError(null);
        setCompletedCallTypes(new Set(data.completedCallTypes ?? []));
        setSelectedTypes((prev) =>
          prev.size === 0 ? new Set(registry.map((c: AiCallDescriptor) => c.type)) : prev
        );
      })
      .catch((err) => {
        setRegistryError(String(err));
      })
      .finally(() => setRegistryLoading(false));
  }, [jobId]);

  // Load existing plaque schedule on mount
  useEffect(() => {
    setPlaqueLoading(true);
    setPlaqueLoadError(null);
    apiFetch(`/api/jobs/${jobId}/plaque-schedule`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        return res.json();
      })
      .then((data: { plaques: PlaqueRow[] }) => {
        setPlaqueRows(data.plaques ?? []);
      })
      .catch((err) => {
        setPlaqueLoadError(String(err));
      })
      .finally(() => setPlaqueLoading(false));
  }, [jobId]);

  // Load existing occupant loads on mount
  useEffect(() => {
    setOccupantLoading(true);
    setOccupantLoadError(null);
    setConfirmDeleteId(null);
    apiFetch(`/api/jobs/${jobId}/occupant-loads`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        return res.json();
      })
      .then((data: { loads: OccupantLoadRow[] }) => {
        setOccupantRows(data.loads ?? []);
      })
      .catch((err) => {
        setOccupantLoadError(String(err));
      })
      .finally(() => setOccupantLoading(false));
  }, [jobId]);

  const isRunning = (type: string) => callStates[type]?.status === "running";
  const anyRunning = Object.values(callStates).some((s) => s.status === "running") || runAllState === "running";

  const runScan = useCallback(async (callTypes: string[]) => {
    const setStatus = (type: string, status: CallState["status"], result?: AiScanResult) => {
      setCallStates((prev) => ({
        ...prev,
        [type]: { status, result },
      }));
    };

    callTypes.forEach((type) => setStatus(type, "running"));

    try {
      const res = await apiFetch(`/api/jobs/${jobId}/ai-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callTypes }),
      });
      const data: AiScanResult = await res.json();
      if (res.ok && data.success) {
        callTypes.forEach((type) => setStatus(type, "success", data));
        setCompletedCallTypes((prev) => new Set([...prev, ...(data.successfulCallTypes ?? callTypes)]));
        onScansComplete();
      } else {
        callTypes.forEach((type) => setStatus(type, "error", { ...data, error: data.error ?? "Scan failed" }));
      }
    } catch (err) {
      const errResult: AiScanResult = { success: false, newSignsCreated: 0, signsUpdated: 0, details: {}, error: String(err) };
      callTypes.forEach((type) => setStatus(type, "error", errResult));
    }
  }, [jobId, onScansComplete]);

  const handleRunOne = async (type: string) => {
    await runScan([type]);
  };

  const handleRunSelected = async () => {
    if (selectedTypes.size === 0) return;
    setRunAllState("running");
    await runScan(Array.from(selectedTypes));
    setRunAllState("done");
  };

  const handleRunAll = async () => {
    setRunAllState("running");
    await runScan(callRegistry.map((d) => d.type));
    setRunAllState("done");
  };

  const toggleSelect = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const togglePromptExpand = (type: string) => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const handleExtractPlaqueSchedule = async () => {
    setPlaqueStatus("running");
    setPlaqueError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/extract-plaque-schedule`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        // Refresh plaque rows from GET
        const getRes = await apiFetch(`/api/jobs/${jobId}/plaque-schedule`);
        if (getRes.ok) {
          const getData: { plaques: PlaqueRow[] } = await getRes.json();
          setPlaqueRows(getData.plaques ?? []);
        }
        setPlaqueStatus("success");
      } else {
        setPlaqueError(data.error ?? "Extraction failed");
        setPlaqueStatus("error");
      }
    } catch (err) {
      setPlaqueError(String(err));
      setPlaqueStatus("error");
    }
  };

  const handleEditPlaqueRow = (row: PlaqueRow) => {
    setPlaqueConfirmDeleteId(null);
    setPlaqueEditingId(row.id);
    setPlaqueEditDraft({
      typeId: row.typeId,
      name: row.name ?? "",
      braille: row.braille === true ? "true" : row.braille === false ? "false" : "",
      letterHeight: row.letterHeight ?? "",
      trigger: row.trigger ?? "",
    });
    setPlaqueEditError(null);
  };

  const handleAddPlaqueRow = () => {
    setPlaqueConfirmDeleteId(null);
    setPlaqueEditingId("__new__");
    setPlaqueEditDraft({ typeId: "", name: "", braille: "", letterHeight: "", trigger: "" });
    setPlaqueEditError(null);
  };

  const handleCancelPlaqueEdit = () => {
    setPlaqueEditingId(null);
    setPlaqueEditDraft({ typeId: "", name: "", braille: "", letterHeight: "", trigger: "" });
    setPlaqueEditError(null);
  };

  const handleSavePlaqueRow = async () => {
    if (!plaqueEditDraft.typeId.trim()) {
      setPlaqueEditError("Type ID is required.");
      return;
    }
    setPlaqueEditSaving(true);
    setPlaqueEditError(null);

    const brailleVal = plaqueEditDraft.braille === "true" ? true : plaqueEditDraft.braille === "false" ? false : null;

    const body = {
      typeId: plaqueEditDraft.typeId.trim(),
      name: plaqueEditDraft.name.trim() || null,
      braille: brailleVal,
      letterHeight: plaqueEditDraft.letterHeight.trim() || null,
      trigger: plaqueEditDraft.trigger.trim() || null,
    };

    try {
      if (plaqueEditingId === "__new__") {
        const res = await apiFetch(`/api/jobs/${jobId}/plaque-schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setPlaqueEditError(data.error ?? "Failed to create row");
          return;
        }
        setPlaqueRows((prev) => [...prev, data.plaque as PlaqueRow]);
      } else {
        const res = await apiFetch(`/api/jobs/${jobId}/plaque-schedule/${plaqueEditingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setPlaqueEditError(data.error ?? "Failed to update row");
          return;
        }
        setPlaqueRows((prev) => prev.map((r) => r.id === plaqueEditingId ? (data.plaque as PlaqueRow) : r));
      }
      setPlaqueEditingId(null);
      setPlaqueEditDraft({ typeId: "", name: "", braille: "", letterHeight: "", trigger: "" });
    } catch (err) {
      setPlaqueEditError(String(err));
    } finally {
      setPlaqueEditSaving(false);
    }
  };

  const handleDeletePlaqueRow = async (id: string) => {
    setPlaqueDeletingId(id);
    setPlaqueEditError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/plaque-schedule/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        setPlaqueEditError(data.error ?? "Failed to delete row.");
        return;
      }
      setPlaqueRows((prev) => prev.filter((r) => r.id !== id));
      if (plaqueEditingId === id) {
        setPlaqueEditingId(null);
      }
    } catch (err) {
      setPlaqueEditError(String(err));
    } finally {
      setPlaqueDeletingId(null);
    }
  };

  const handleUnlockPlaqueRow = async (id: string) => {
    setPlaqueUnlockingId(id);
    setPlaqueEditError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/plaque-schedule/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manuallyEdited: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPlaqueEditError(data.error ?? "Failed to unlock row.");
        return;
      }
      setPlaqueRows((prev) => prev.map((r) => r.id === id ? (data.plaque as PlaqueRow) : r));
    } catch (err) {
      setPlaqueEditError(String(err));
    } finally {
      setPlaqueUnlockingId(null);
    }
  };

  const handleUnlockAllPlaqueRows = async () => {
    const lockedIds = plaqueRows.filter((r) => r.manuallyEdited).map((r) => r.id);
    if (lockedIds.length === 0) return;
    setPlaqueUnlockingAll(true);
    setPlaqueEditError(null);
    try {
      const results = await Promise.all(
        lockedIds.map(async (id) => {
          try {
            const res = await apiFetch(`/api/jobs/${jobId}/plaque-schedule/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ manuallyEdited: false }),
            });
            return { id, ok: res.ok };
          } catch {
            return { id, ok: false };
          }
        })
      );
      const unlockedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const failedCount = results.filter((r) => !r.ok).length;
      if (unlockedIds.size > 0) {
        setPlaqueRows((prev) => prev.map((r) => unlockedIds.has(r.id) ? { ...r, manuallyEdited: false } : r));
      }
      if (failedCount > 0) {
        setPlaqueEditError(`${failedCount} row${failedCount !== 1 ? "s" : ""} could not be unlocked. Please try again.`);
      }
    } catch (err) {
      setPlaqueEditError(String(err));
    } finally {
      setPlaqueUnlockingAll(false);
    }
  };

  const handleExtractOccupantLoads = async () => {
    setOccupantStatus("running");
    setOccupantError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/extract-occupant-loads`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        // Refresh occupant rows from GET
        const getRes = await apiFetch(`/api/jobs/${jobId}/occupant-loads`);
        if (getRes.ok) {
          const getData: { loads: OccupantLoadRow[] } = await getRes.json();
          setOccupantRows(getData.loads ?? []);
          setConfirmDeleteId(null);
        }
        setOccupantStatus("success");
      } else {
        setOccupantError(data.error ?? "Extraction failed");
        setOccupantStatus("error");
      }
    } catch (err) {
      setOccupantError(String(err));
      setOccupantStatus("error");
    }
  };

  const handleEditRow = (row: OccupantLoadRow) => {
    setConfirmDeleteId(null);
    setEditingId(row.id);
    setEditDraft({
      roomNum: row.roomNum,
      roomName: row.roomName ?? "",
      occupantLoad: row.occupantLoad !== null && row.occupantLoad !== undefined ? String(row.occupantLoad) : "",
      occupancyGroup: row.occupancyGroup ?? "",
    });
    setEditError(null);
  };

  const handleAddRow = () => {
    setConfirmDeleteId(null);
    setEditingId("__new__");
    setEditDraft({ roomNum: "", roomName: "", occupantLoad: "", occupancyGroup: "" });
    setEditError(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditDraft({ roomNum: "", roomName: "", occupantLoad: "", occupancyGroup: "" });
    setEditError(null);
  };

  const handleSaveRow = async () => {
    if (!editDraft.roomNum.trim()) {
      setEditError("Room # is required.");
      return;
    }
    setEditSaving(true);
    setEditError(null);

    const rawLoad = editDraft.occupantLoad.trim();
    let parsedLoad: number | null = null;
    if (rawLoad !== "") {
      const n = parseFloat(rawLoad);
      if (!Number.isFinite(n) || n < 0) {
        setEditError("Occupant load must be a valid non-negative number.");
        setEditSaving(false);
        return;
      }
      parsedLoad = n;
    }

    const body = {
      roomNum: editDraft.roomNum.trim(),
      roomName: editDraft.roomName.trim() || null,
      occupantLoad: parsedLoad,
      occupancyGroup: editDraft.occupancyGroup.trim() || null,
    };

    try {
      if (editingId === "__new__") {
        const res = await apiFetch(`/api/jobs/${jobId}/occupant-loads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setEditError(data.error ?? "Failed to create row");
          return;
        }
        setOccupantRows((prev) => [...prev, data.load as OccupantLoadRow]);
      } else {
        const res = await apiFetch(`/api/jobs/${jobId}/occupant-loads/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setEditError(data.error ?? "Failed to update row");
          return;
        }
        setOccupantRows((prev) => prev.map((r) => r.id === editingId ? (data.load as OccupantLoadRow) : r));
      }
      setEditingId(null);
      setEditDraft({ roomNum: "", roomName: "", occupantLoad: "", occupancyGroup: "" });
    } catch (err) {
      setEditError(String(err));
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteRow = async (id: string) => {
    setDeletingId(id);
    setEditError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/occupant-loads/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        setEditError(data.error ?? "Failed to delete row.");
        return;
      }
      setOccupantRows((prev) => prev.filter((r) => r.id !== id));
      if (editingId === id) {
        setEditingId(null);
      }
    } catch (err) {
      setEditError(String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleUnlockRow = async (id: string) => {
    setUnlockingId(id);
    setEditError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/occupant-loads/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manuallyEdited: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditError(data.error ?? "Failed to unlock row.");
        return;
      }
      setOccupantRows((prev) => prev.map((r) => r.id === id ? (data.load as OccupantLoadRow) : r));
    } catch (err) {
      setEditError(String(err));
    } finally {
      setUnlockingId(null);
    }
  };

  const handleUnlockAllOccupantRows = async () => {
    const lockedIds = occupantRows.filter((r) => r.manuallyEdited).map((r) => r.id);
    if (lockedIds.length === 0) return;
    setUnlockingAll(true);
    setEditError(null);
    try {
      const results = await Promise.all(
        lockedIds.map(async (id) => {
          try {
            const res = await apiFetch(`/api/jobs/${jobId}/occupant-loads/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ manuallyEdited: false }),
            });
            return { id, ok: res.ok };
          } catch {
            return { id, ok: false };
          }
        })
      );
      const unlockedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const failedCount = results.filter((r) => !r.ok).length;
      if (unlockedIds.size > 0) {
        setOccupantRows((prev) => prev.map((r) => unlockedIds.has(r.id) ? { ...r, manuallyEdited: false } : r));
      }
      if (failedCount > 0) {
        setEditError(`${failedCount} row${failedCount !== 1 ? "s" : ""} could not be unlocked. Please try again.`);
      }
    } catch (err) {
      setEditError(String(err));
    } finally {
      setUnlockingAll(false);
    }
  };

  const lastRunResult = Object.values(callStates).find((s) => s.status === "success")?.result;
  const anySuccess = Object.values(callStates).some((s) => s.status === "success");

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="w-5 h-5 text-violet-400" />
            <h2 className="text-sm font-display font-bold text-foreground uppercase tracking-wide">AI Scans</h2>
          </div>
          <p className="text-xs text-muted-foreground max-w-lg">
            AI scan calls are separate from PDF processing. Run them on-demand below.
            Signs created by AI scans are highlighted in <span className="text-violet-400 font-semibold">violet</span> throughout the app.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onToggleAiHighlight}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-all ${
              showAiHighlight
                ? "bg-violet-500/15 text-violet-400 border-violet-500/30 hover:bg-violet-500/25"
                : "bg-secondary text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {showAiHighlight ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            AI Highlights {showAiHighlight ? "On" : "Off"}
          </button>
          <button
            onClick={handleRunSelected}
            disabled={anyRunning || selectedTypes.size === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {runAllState === "running" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            Run Selected ({selectedTypes.size})
          </button>
          <button
            onClick={handleRunAll}
            disabled={anyRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium bg-secondary text-muted-foreground border border-border hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {runAllState === "running" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Brain className="w-3.5 h-3.5" />
            )}
            Run All
          </button>
        </div>
      </div>

      {/* Summary of last scan */}
      {anySuccess && lastRunResult && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs text-violet-300">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-violet-400" />
          <span>
            Last scan created <strong>{lastRunResult.newSignsCreated}</strong> new signs
            and updated <strong>{lastRunResult.signsUpdated}</strong> existing signs.
            {lastRunResult.newSignsCreated > 0 && " Reload the Sign Table to see them."}
          </span>
        </div>
      )}

      {/* Registry loading / error states */}
      {registryLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading AI call types…
        </div>
      )}
      {registryError && (
        <div className="flex items-center gap-2 text-xs text-destructive py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> Failed to load call types: {registryError}
        </div>
      )}

      {/* AI Call Cards */}
      {!registryLoading && (
        <div className="grid gap-3">
          {callRegistry.map((call) => {
            const state = callStates[call.type];
            const selected = selectedTypes.has(call.type);
            const promptExpanded = expandedPrompts.has(call.type);
            return (
              <div
                key={call.type}
                className={`rounded-lg border transition-all ${
                  selected
                    ? "bg-violet-500/5 border-violet-500/20"
                    : "bg-card border-border"
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelect(call.type)}
                    className="mt-1 accent-violet-500 cursor-pointer"
                  />

                  {/* Icon */}
                  <div className="flex-shrink-0 mt-0.5">
                    {CALL_TYPE_ICONS[call.type] ?? <Cpu className="w-4 h-4 text-muted-foreground" />}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-foreground">{call.name}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/60 bg-secondary px-1.5 py-0.5 rounded">
                        {call.type}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {call.description}
                    </p>

                    {/* Expandable prompt */}
                    {call.prompt && (
                      <button
                        onClick={() => togglePromptExpand(call.type)}
                        className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      >
                        {promptExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        {promptExpanded ? "Hide prompt" : "Show prompt"}
                      </button>
                    )}
                    {promptExpanded && call.prompt && (
                      <pre className="mt-2 p-2 rounded bg-secondary/50 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto border border-border/50">
                        {call.prompt}
                      </pre>
                    )}

                    {/* Result */}
                    {state?.status === "success" && state.result && (
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-violet-400">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>
                          +{state.result.newSignsCreated} new signs · {state.result.signsUpdated} updated
                        </span>
                      </div>
                    )}
                    {state?.status === "error" && (
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-destructive">
                        <AlertTriangle className="w-3 h-3" />
                        <span>{state.result?.error ?? "Scan failed"}</span>
                      </div>
                    )}
                  </div>

                  {/* Run button */}
                  {confirmRunOneType === call.type ? (
                    <div className="flex-shrink-0 flex items-center gap-1.5">
                      <span className="text-[11px] text-amber-400 whitespace-nowrap">Replace existing results?</span>
                      <button
                        onClick={() => { setConfirmRunOneType(null); handleRunOne(call.type); }}
                        disabled={anyRunning}
                        className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-white bg-amber-500 hover:bg-amber-400 transition-colors border border-amber-400/30 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Continue
                      </button>
                      <button
                        onClick={() => setConfirmRunOneType(null)}
                        className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-muted-foreground bg-secondary hover:text-foreground transition-colors border border-border"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        if (completedCallTypes.has(call.type)) {
                          setConfirmRunOneType(call.type);
                        } else {
                          handleRunOne(call.type);
                        }
                      }}
                      disabled={anyRunning}
                      className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                        state?.status === "success"
                          ? "bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/20"
                          : state?.status === "error"
                          ? "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20"
                          : "bg-secondary text-muted-foreground border-border hover:text-foreground hover:border-border/80"
                      }`}
                    >
                      {isRunning(call.type) ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : state?.status === "success" ? (
                        <CheckCircle2 className="w-3 h-3" />
                      ) : state?.status === "error" ? (
                        <AlertTriangle className="w-3 h-3" />
                      ) : (
                        <Play className="w-3 h-3" />
                      )}
                      {isRunning(call.type)
                        ? "Running…"
                        : state?.status === "success"
                        ? "Re-run"
                        : state?.status === "error"
                        ? "Retry"
                        : "Run"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Step 3: Plaque Schedule ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 p-3 border-b border-border">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <div>
              <span className="text-xs font-medium text-foreground">Step 3: Plaque Schedule</span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Extract sign type definitions (plaque types, braille, letter height) from the sign schedule pages.
              </p>
            </div>
          </div>
          <div className="flex-shrink-0 flex items-center gap-2">
            {plaqueRows.some((r) => r.manuallyEdited) && !showPlaqueConfirm && (
              <button
                onClick={handleUnlockAllPlaqueRows}
                disabled={plaqueUnlockingAll || plaqueEditingId !== null || plaqueDeletingId !== null || plaqueUnlockingId !== null || plaqueConfirmDeleteId !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20"
                title="Remove the manually-edited lock from all rows, allowing AI to update them again"
              >
                {plaqueUnlockingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LockOpen className="w-3.5 h-3.5" />}
                Unlock all
              </button>
            )}
            {showPlaqueConfirm ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-amber-400 whitespace-nowrap">Replace existing rows?</span>
                <button
                  onClick={() => { setShowPlaqueConfirm(false); handleExtractPlaqueSchedule(); }}
                  className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-white bg-amber-500 hover:bg-amber-400 transition-colors border border-amber-400/30"
                >
                  Continue
                </button>
                <button
                  onClick={() => setShowPlaqueConfirm(false)}
                  className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-muted-foreground bg-secondary hover:text-foreground transition-colors border border-border"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  if (plaqueRows.length > 0) {
                    setShowPlaqueConfirm(true);
                  } else {
                    handleExtractPlaqueSchedule();
                  }
                }}
                disabled={plaqueStatus === "running" || plaqueUnlockingAll}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  plaqueStatus === "success"
                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20"
                    : plaqueStatus === "error"
                    ? "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20"
                    : "bg-secondary text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {plaqueStatus === "running" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : plaqueStatus === "success" ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : plaqueStatus === "error" ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {plaqueStatus === "running"
                  ? "Running…"
                  : plaqueStatus === "success"
                  ? "Re-run"
                  : plaqueStatus === "error"
                  ? "Retry"
                  : "Run"}
              </button>
            )}
          </div>
        </div>

        {plaqueError && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive border-b border-border">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {plaqueError}
          </div>
        )}
        {plaqueLoadError && !plaqueLoading && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive border-b border-border">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            Could not load saved plaque schedule: {plaqueLoadError}
          </div>
        )}

        {plaqueLoading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading plaque schedule…
          </div>
        ) : plaqueLoadError ? null : (
          <div className="overflow-x-auto">
            {plaqueRows.length === 0 && plaqueEditingId !== "__new__" && (
              <div className="px-3 py-4 text-[11px] text-muted-foreground">
                No plaque types extracted yet. Run the extraction above or add rows manually.
              </div>
            )}

            {(plaqueRows.length > 0 || plaqueEditingId === "__new__") && (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type ID</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Braille</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Letter Height</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Trigger</th>
                    <th className="px-3 py-2 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {plaqueRows.map((row) => {
                    const isEditing = plaqueEditingId === row.id;
                    const isDeleting = plaqueDeletingId === row.id;

                    if (isEditing) {
                      return (
                        <tr key={row.id} className="border-b border-amber-500/20 bg-amber-500/5">
                          <td className="px-2 py-1.5">
                            <input
                              autoFocus
                              value={plaqueEditDraft.typeId}
                              onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, typeId: e.target.value }))}
                              placeholder="e.g. P-1"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60 font-mono"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              value={plaqueEditDraft.name}
                              onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, name: e.target.value }))}
                              placeholder="Sign name"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <select
                              value={plaqueEditDraft.braille}
                              onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, braille: e.target.value }))}
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                            >
                              <option value="">—</option>
                              <option value="true">Yes</option>
                              <option value="false">No</option>
                            </select>
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              value={plaqueEditDraft.letterHeight}
                              onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, letterHeight: e.target.value }))}
                              placeholder='e.g. 5/8"'
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              value={plaqueEditDraft.trigger}
                              onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, trigger: e.target.value }))}
                              placeholder="Trigger condition"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={handleSavePlaqueRow}
                                disabled={plaqueEditSaving}
                                className="flex items-center justify-center w-6 h-6 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
                                title="Save"
                              >
                                {plaqueEditSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                onClick={handleCancelPlaqueEdit}
                                disabled={plaqueEditSaving}
                                className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    const isPlaqueUnlocking = plaqueUnlockingId === row.id;
                    return (
                      <tr
                        key={row.id}
                        ref={plaqueConfirmDeleteId === row.id ? plaqueConfirmRef : null}
                        className={`border-b border-border/50 hover:bg-secondary/20 transition-colors group ${isDeleting || isPlaqueUnlocking ? "opacity-40" : ""}`}
                      >
                        <td className="px-3 py-2 font-mono text-amber-400">
                          <span className="flex items-center gap-1.5">
                            {row.typeId}
                            {row.manuallyEdited && (
                              <span
                                title="This row was manually edited and will not be overwritten by AI re-runs"
                                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 cursor-default"
                              >
                                <Pencil className="w-2.5 h-2.5" />
                                edited
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-foreground">{row.name ?? <span className="text-muted-foreground/50">—</span>}</td>
                        <td className="px-3 py-2">
                          {row.braille === true ? (
                            <span className="text-emerald-400">Yes</span>
                          ) : row.braille === false ? (
                            <span className="text-muted-foreground">No</span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-foreground">{row.letterHeight ?? <span className="text-muted-foreground/50">—</span>}</td>
                        <td className="px-3 py-2 text-foreground">{row.trigger ?? <span className="text-muted-foreground/50">—</span>}</td>
                        <td className="px-2 py-2">
                          {plaqueConfirmDeleteId === row.id ? (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-destructive whitespace-nowrap mr-1">Delete?</span>
                              <button
                                onClick={() => { setPlaqueConfirmDeleteId(null); handleDeletePlaqueRow(row.id); }}
                                disabled={isDeleting}
                                className="flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-medium text-white bg-destructive hover:bg-destructive/80 transition-colors disabled:opacity-50"
                                title="Confirm delete"
                              >
                                {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : "Yes"}
                              </button>
                              <button
                                onClick={() => setPlaqueConfirmDeleteId(null)}
                                disabled={isDeleting}
                                className="flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-medium text-muted-foreground bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              {row.manuallyEdited && (
                                <button
                                  onClick={() => handleUnlockPlaqueRow(row.id)}
                                  disabled={plaqueEditingId !== null || plaqueDeletingId !== null || plaqueUnlockingId !== null || plaqueConfirmDeleteId !== null}
                                  className="flex items-center justify-center w-6 h-6 rounded text-amber-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-30"
                                  title="Unlock row — allow AI to update again"
                                  aria-label="Unlock row"
                                >
                                  {isPlaqueUnlocking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />}
                                </button>
                              )}
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  data-testid={`plaque-edit-row-${row.id}`}
                                  onClick={() => handleEditPlaqueRow(row)}
                                  disabled={plaqueEditingId !== null || plaqueDeletingId !== null || plaqueUnlockingId !== null || plaqueConfirmDeleteId !== null}
                                  className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-30"
                                  title="Edit row"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  data-testid={`plaque-delete-row-${row.id}`}
                                  onClick={() => setPlaqueConfirmDeleteId(row.id)}
                                  disabled={plaqueEditingId !== null || plaqueDeletingId !== null || plaqueUnlockingId !== null || plaqueConfirmDeleteId !== null}
                                  className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-30"
                                  title="Delete row"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {/* New row being added */}
                  {plaqueEditingId === "__new__" && (
                    <tr className="border-b border-amber-500/20 bg-amber-500/5">
                      <td className="px-2 py-1.5">
                        <input
                          autoFocus
                          value={plaqueEditDraft.typeId}
                          onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, typeId: e.target.value }))}
                          placeholder="e.g. P-1"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60 font-mono"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={plaqueEditDraft.name}
                          onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, name: e.target.value }))}
                          placeholder="Sign name"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          value={plaqueEditDraft.braille}
                          onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, braille: e.target.value }))}
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                        >
                          <option value="">—</option>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={plaqueEditDraft.letterHeight}
                          onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, letterHeight: e.target.value }))}
                          placeholder='e.g. 5/8"'
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={plaqueEditDraft.trigger}
                          onChange={(e) => setPlaqueEditDraft((d) => ({ ...d, trigger: e.target.value }))}
                          placeholder="Trigger condition"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-amber-500/60"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={handleSavePlaqueRow}
                            disabled={plaqueEditSaving}
                            className="flex items-center justify-center w-6 h-6 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
                            title="Save"
                          >
                            {plaqueEditSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={handleCancelPlaqueEdit}
                            disabled={plaqueEditSaving}
                            className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                            title="Cancel"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {plaqueEditError && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive border-t border-border/50">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                {plaqueEditError}
              </div>
            )}

            <div className="px-3 py-2 text-[10px] text-muted-foreground border-t border-border/50 flex items-center gap-3">
              <button
                data-testid="plaque-add-row"
                onClick={handleAddPlaqueRow}
                disabled={plaqueEditingId !== null || plaqueDeletingId !== null || plaqueConfirmDeleteId !== null}
                className="flex items-center gap-1 text-amber-400 hover:text-amber-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add row
              </button>
              {plaqueRows.length > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span>{plaqueRows.length} plaque type{plaqueRows.length !== 1 ? "s" : ""}</span>
                  {plaqueRows.filter((r) => r.manuallyEdited).length > 0 && (
                    <>
                      <span className="text-border">·</span>
                      <span className="text-amber-400">{plaqueRows.filter((r) => r.manuallyEdited).length} manually protected</span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Step 4b: Occupant Loads ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 p-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-sky-400 flex-shrink-0" />
            <div>
              <span className="text-xs font-medium text-foreground">Step 4b: Occupant Loads</span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Scan egress drawings for room capacities and occupancy groups. Assembly rooms (≥ 50 occupants) are highlighted.
              </p>
            </div>
          </div>
          <div className="flex-shrink-0 flex items-center gap-2">
            {occupantRows.some((r) => r.manuallyEdited) && !showOccupantConfirm && (
              <button
                onClick={handleUnlockAllOccupantRows}
                disabled={unlockingAll || editingId !== null || deletingId !== null || unlockingId !== null || confirmDeleteId !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-sky-500/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/20"
                title="Remove the manually-edited lock from all rows, allowing AI to update them again"
              >
                {unlockingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LockOpen className="w-3.5 h-3.5" />}
                Unlock all
              </button>
            )}
            {showOccupantConfirm ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-sky-400 whitespace-nowrap">Replace existing rows?</span>
                <button
                  onClick={() => { setShowOccupantConfirm(false); handleExtractOccupantLoads(); }}
                  className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-white bg-sky-500 hover:bg-sky-400 transition-colors border border-sky-400/30"
                >
                  Continue
                </button>
                <button
                  onClick={() => setShowOccupantConfirm(false)}
                  className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-muted-foreground bg-secondary hover:text-foreground transition-colors border border-border"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  if (occupantRows.length > 0) {
                    setShowOccupantConfirm(true);
                  } else {
                    handleExtractOccupantLoads();
                  }
                }}
                disabled={occupantStatus === "running" || unlockingAll}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  occupantStatus === "success"
                    ? "bg-sky-500/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/20"
                    : occupantStatus === "error"
                    ? "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20"
                    : "bg-secondary text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {occupantStatus === "running" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : occupantStatus === "success" ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : occupantStatus === "error" ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {occupantStatus === "running"
                  ? "Running…"
                  : occupantStatus === "success"
                  ? "Re-run"
                  : occupantStatus === "error"
                  ? "Retry"
                  : "Run"}
              </button>
            )}
          </div>
        </div>

        {occupantError && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive border-b border-border">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {occupantError}
          </div>
        )}

        {occupantLoadError && !occupantLoading && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive border-b border-border">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            Could not load saved occupant loads: {occupantLoadError}
          </div>
        )}

        {occupantLoading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading occupant loads…
          </div>
        ) : (
          <div className="overflow-x-auto">
            {occupantRows.length === 0 && editingId !== "__new__" && (
              <div className="px-3 py-4 text-[11px] text-muted-foreground">
                No occupant load data extracted yet. Run the extraction above or add rows manually.
              </div>
            )}

            {(occupantRows.length > 0 || editingId === "__new__") && (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Room #</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Room Name</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Occupant Load</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Occupancy Group</th>
                    <th className="px-3 py-2 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {occupantRows.map((row) => {
                    const isAssembly = typeof row.occupantLoad === "number" && row.occupantLoad >= 50;
                    const isEditing = editingId === row.id;
                    const isDeleting = deletingId === row.id;

                    if (isEditing) {
                      return (
                        <tr key={row.id} className="border-b border-sky-500/20 bg-sky-500/5">
                          <td className="px-2 py-1.5">
                            <input
                              autoFocus
                              value={editDraft.roomNum}
                              onChange={(e) => setEditDraft((d) => ({ ...d, roomNum: e.target.value }))}
                              placeholder="Room #"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60 font-mono"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              value={editDraft.roomName}
                              onChange={(e) => setEditDraft((d) => ({ ...d, roomName: e.target.value }))}
                              placeholder="Room name"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              value={editDraft.occupantLoad}
                              onChange={(e) => setEditDraft((d) => ({ ...d, occupantLoad: e.target.value }))}
                              placeholder="0"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              value={editDraft.occupancyGroup}
                              onChange={(e) => setEditDraft((d) => ({ ...d, occupancyGroup: e.target.value }))}
                              placeholder="e.g. A-2"
                              className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={handleSaveRow}
                                disabled={editSaving}
                                className="flex items-center justify-center w-6 h-6 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
                                title="Save"
                              >
                                {editSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={editSaving}
                                className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    const isUnlocking = unlockingId === row.id;
                    return (
                      <tr
                        key={row.id}
                        ref={confirmDeleteId === row.id ? confirmRef : null}
                        className={`border-b border-border/50 transition-colors group ${
                          isAssembly ? "bg-orange-500/8 hover:bg-orange-500/12" : "hover:bg-secondary/20"
                        } ${isDeleting || isUnlocking ? "opacity-40" : ""}`}
                      >
                        <td className="px-3 py-2 font-mono text-sky-400">
                          <span className="flex items-center gap-1.5">
                            {row.roomNum}
                            {row.manuallyEdited && (
                              <span
                                title="This row was manually edited and will not be overwritten by AI re-runs"
                                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20 cursor-default"
                              >
                                <Pencil className="w-2.5 h-2.5" />
                                edited
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          {row.roomName ?? <span className="text-muted-foreground/50">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {row.occupantLoad !== null && row.occupantLoad !== undefined ? (
                            <span className={isAssembly ? "text-orange-400 font-semibold" : "text-foreground"}>
                              {row.occupantLoad}
                              {isAssembly && (
                                <span className="ml-1.5 text-[10px] font-normal px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/20">
                                  assembly
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          {row.occupancyGroup ?? <span className="text-muted-foreground/50">—</span>}
                        </td>
                        <td className="px-2 py-2">
                          {confirmDeleteId === row.id ? (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-destructive whitespace-nowrap mr-1">Delete?</span>
                              <button
                                onClick={() => { setConfirmDeleteId(null); handleDeleteRow(row.id); }}
                                disabled={isDeleting}
                                className="flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-medium text-white bg-destructive hover:bg-destructive/80 transition-colors disabled:opacity-50"
                                title="Confirm delete"
                              >
                                {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : "Yes"}
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                disabled={isDeleting}
                                className="flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-medium text-muted-foreground bg-secondary hover:text-foreground transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              {row.manuallyEdited && (
                                <button
                                  onClick={() => handleUnlockRow(row.id)}
                                  disabled={editingId !== null || deletingId !== null || unlockingId !== null || confirmDeleteId !== null}
                                  className="flex items-center justify-center w-6 h-6 rounded text-sky-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-30"
                                  title="Unlock row — allow AI to update again"
                                  aria-label="Unlock row"
                                >
                                  {isUnlocking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />}
                                </button>
                              )}
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  data-testid={`occupant-edit-row-${row.id}`}
                                  onClick={() => handleEditRow(row)}
                                  disabled={editingId !== null || deletingId !== null || unlockingId !== null || confirmDeleteId !== null}
                                  className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-30"
                                  title="Edit row"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  data-testid={`occupant-delete-row-${row.id}`}
                                  onClick={() => setConfirmDeleteId(row.id)}
                                  disabled={editingId !== null || deletingId !== null || unlockingId !== null || confirmDeleteId !== null}
                                  className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-30"
                                  title="Delete row"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {/* New row being added */}
                  {editingId === "__new__" && (
                    <tr className="border-b border-sky-500/20 bg-sky-500/5">
                      <td className="px-2 py-1.5">
                        <input
                          autoFocus
                          value={editDraft.roomNum}
                          onChange={(e) => setEditDraft((d) => ({ ...d, roomNum: e.target.value }))}
                          placeholder="Room #"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60 font-mono"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={editDraft.roomName}
                          onChange={(e) => setEditDraft((d) => ({ ...d, roomName: e.target.value }))}
                          placeholder="Room name"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          value={editDraft.occupantLoad}
                          onChange={(e) => setEditDraft((d) => ({ ...d, occupantLoad: e.target.value }))}
                          placeholder="0"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={editDraft.occupancyGroup}
                          onChange={(e) => setEditDraft((d) => ({ ...d, occupancyGroup: e.target.value }))}
                          placeholder="e.g. A-2"
                          className="w-full bg-background border border-border rounded px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-sky-500/60"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={handleSaveRow}
                            disabled={editSaving}
                            className="flex items-center justify-center w-6 h-6 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
                            title="Save"
                          >
                            {editSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            disabled={editSaving}
                            className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                            title="Cancel"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {/* Validation error for editing */}
            {editError && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-destructive border-t border-border/50">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                {editError}
              </div>
            )}

            <div className="px-3 py-2 text-[10px] text-muted-foreground border-t border-border/50 flex items-center gap-3">
              <button
                data-testid="occupant-add-row"
                onClick={handleAddRow}
                disabled={editingId !== null || deletingId !== null}
                className="flex items-center gap-1 text-sky-400 hover:text-sky-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add row
              </button>
              {occupantRows.length > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span>{occupantRows.length} room{occupantRows.length !== 1 ? "s" : ""}</span>
                  {occupantRows.filter((r) => typeof r.occupantLoad === "number" && r.occupantLoad >= 50).length > 0 && (
                    <span className="text-orange-400">
                      · {occupantRows.filter((r) => typeof r.occupantLoad === "number" && r.occupantLoad >= 50).length} assembly room{occupantRows.filter((r) => typeof r.occupantLoad === "number" && r.occupantLoad >= 50).length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {occupantRows.filter((r) => r.manuallyEdited).length > 0 && (
                    <>
                      <span className="text-border">·</span>
                      <span className="text-sky-400">{occupantRows.filter((r) => r.manuallyEdited).length} manually protected</span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="space-y-2">
        {/* Color swatch row */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-sm bg-violet-500/70 border border-violet-500/30 flex-shrink-0" />
            <span>AI-sourced sign row</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-sm bg-violet-500/20 border border-violet-500/40 flex-shrink-0" />
            <span>AI-contributed bbox cell</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-full border-2 border-violet-500 border-dashed flex-shrink-0" />
            <span>AI-sourced floor plan marker</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block w-3 h-3 rounded-sm bg-orange-500/15 border border-orange-500/20 flex-shrink-0" />
            <span>Assembly room (≥ 50 occupants)</span>
          </div>
        </div>
        {/* Call type legend */}
        <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30 border border-border">
          <Info className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground mt-0.5" />
          <div className="text-[11px] text-muted-foreground space-y-1">
            <p><strong className="text-violet-400">Sign Schedule Text</strong> + <strong className="text-violet-400">Floor Plan Text</strong> — primary sign extraction calls. Run these to populate the sign table.</p>
            <p><strong className="text-orange-400">Vision Fallback</strong> + <strong className="text-orange-400">Bbox Detection</strong> — visual scans of floor plan images. Useful for callouts not in the text layer.</p>
            <p><strong className="text-blue-400">Project Info</strong> — reads title blocks to fill project location fields. Run once per job.</p>
            <p><strong className="text-amber-400">Title Block Vision</strong> — uses AI vision to detect floor level names from each page's title block.</p>
            <p><strong className="text-amber-400">Step 3: Plaque Schedule</strong> — extracts sign type definitions from the plaque/sign schedule pages.</p>
            <p><strong className="text-sky-400">Step 4b: Occupant Loads</strong> — scans egress drawings for room capacities; assembly rooms are flagged for R9/R10 compliance.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
