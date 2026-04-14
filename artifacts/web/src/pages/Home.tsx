import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import { UploadCloud, FileText, X, AlertCircle, Loader2, BookOpen } from "lucide-react";
import { AppShell } from "@/components/layout/Shell";
import { useUploadJobFiles } from "@/hooks/use-takeoff";
import { formatBytes } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";

export default function Home() {
  const [, setLocation] = useLocation();
  const [planFiles, setPlanFiles] = useState<File[]>([]);
  const [signageDocFiles, setSignageDocFiles] = useState<File[]>([]);
  const uploadMutation = useUploadJobFiles();

  const onDropPlans = useCallback((accepted: File[]) => {
    setPlanFiles(prev => [...prev, ...accepted]);
  }, []);

  const onDropSignageDocs = useCallback((accepted: File[]) => {
    setSignageDocFiles(prev => [...prev, ...accepted]);
  }, []);

  const planDropzone = useDropzone({
    onDrop: onDropPlans,
    accept: { "application/pdf": [".pdf"] },
  });

  const signageDropzone = useDropzone({
    onDrop: onDropSignageDocs,
    accept: { "application/pdf": [".pdf"] },
  });

  const removePlanFile = (index: number) => {
    setPlanFiles(prev => prev.filter((_, i) => i !== index));
  };

  const removeSignageDoc = (index: number) => {
    setSignageDocFiles(prev => prev.filter((_, i) => i !== index));
  };

  const totalCount = planFiles.length + signageDocFiles.length;

  const handleUpload = async () => {
    if (planFiles.length === 0) return;
    try {
      const result = await uploadMutation.mutateAsync({
        data: {
          files: planFiles,
          ...(signageDocFiles.length > 0 ? { signageDocs: signageDocFiles } : {}),
        },
      });
      setLocation(`/jobs/${result.jobId}`);
    } catch (error) {
      console.error("Upload failed", error);
    }
  };

  return (
    <AppShell>
      <div className="flex-1 p-8 md:p-12 max-w-5xl mx-auto w-full">
        <header className="mb-8">
          <h1 className="text-3xl font-display text-foreground mb-2">New Extraction Job</h1>
          <p className="text-muted-foreground font-sans">
            Upload architectural plan PDFs to automatically extract sign schedules,
            callouts, and material specifications using AI.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-5">

            {/* Primary dropzone — plan documents */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Plan Documents
              </h2>
              <div
                {...planDropzone.getRootProps()}
                className={`
                  relative overflow-hidden
                  border-2 border-dashed rounded-xl p-10
                  flex flex-col items-center justify-center text-center
                  transition-all duration-300 cursor-pointer min-h-[220px]
                  ${planDropzone.isDragActive ? "border-primary bg-primary/5" : "border-border bg-card"}
                `}
              >
                <input {...planDropzone.getInputProps()} />
                <div className={`p-4 rounded-full mb-3 transition-colors duration-300 ${planDropzone.isDragActive ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground"}`}>
                  <UploadCloud className="w-7 h-7" />
                </div>
                <h3 className="text-base font-medium text-foreground mb-1 font-display">
                  {planDropzone.isDragActive ? "Drop plan PDFs here…" : "Drag & Drop Plan PDFs"}
                </h3>
                <p className="text-sm text-muted-foreground">
                  Floor plans, sign schedules, and spec sheets. Only .pdf files supported.
                </p>
              </div>

              <AnimatePresence>
                {planFiles.length > 0 && (
                  <motion.ul
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    className="mt-3 space-y-2"
                  >
                    {planFiles.map((file, idx) => (
                      <motion.li
                        key={`${file.name}-${idx}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg bg-secondary border border-border/50"
                      >
                        <FileText className="w-4 h-4 text-primary shrink-0" />
                        <span className="flex-1 text-sm text-foreground truncate font-medium">{file.name}</span>
                        <span className="text-xs text-muted-foreground font-mono shrink-0">{formatBytes(file.size)}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); removePlanFile(idx); }}
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </motion.li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>

            {/* Secondary dropzone — signage docs (sign type library) */}
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-500 mb-2 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5" />
                Sign Type / Criteria Sheets
                <span className="ml-1 text-xs font-normal text-muted-foreground normal-case tracking-normal">(optional)</span>
              </h2>
              <div
                {...signageDropzone.getRootProps()}
                className={`
                  relative overflow-hidden
                  border-2 border-dashed rounded-xl p-8
                  flex flex-col items-center justify-center text-center
                  transition-all duration-300 cursor-pointer min-h-[140px]
                  ${signageDropzone.isDragActive ? "border-amber-500 bg-amber-500/5" : "border-amber-500/30 bg-card"}
                `}
              >
                <input {...signageDropzone.getInputProps()} />
                <div className={`p-3 rounded-full mb-2 transition-colors duration-300 ${signageDropzone.isDragActive ? "bg-amber-500/20 text-amber-500" : "bg-secondary text-amber-500/70"}`}>
                  <BookOpen className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-medium text-foreground font-display mb-0.5">
                  {signageDropzone.isDragActive ? "Drop signage docs here…" : "Drag & Drop Sign Criteria / Type Schedule"}
                </h3>
                <p className="text-xs text-muted-foreground">
                  Uploads here are used exclusively to build the sign type library pre-pass (e.g. A11, Sign Criteria sheets).
                </p>
              </div>

              <AnimatePresence>
                {signageDocFiles.length > 0 && (
                  <motion.ul
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    className="mt-3 space-y-2"
                  >
                    {signageDocFiles.map((file, idx) => (
                      <motion.li
                        key={`${file.name}-${idx}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/25"
                      >
                        <BookOpen className="w-4 h-4 text-amber-500 shrink-0" />
                        <span className="flex-1 text-sm text-foreground truncate font-medium">{file.name}</span>
                        <span className="text-xs text-muted-foreground font-mono shrink-0">{formatBytes(file.size)}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeSignageDoc(idx); }}
                          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </motion.li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>

            {/* Error */}
            {uploadMutation.isError && (
              <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-start gap-3">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <div>
                  <strong className="font-semibold block mb-1">Upload failed</strong>
                  {uploadMutation.error?.message || "An unexpected error occurred during upload."}
                </div>
              </div>
            )}
          </div>

          {/* Summary sidebar */}
          <div className="bg-card rounded-xl border border-border p-6 flex flex-col">
            <h3 className="font-display font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-4">
              Upload Summary
            </h3>

            <div className="flex-1 space-y-3 text-sm">
              <div className="flex justify-between items-center py-2 border-b border-border">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" /> Plan files
                </span>
                <span className="font-mono font-medium text-foreground">{planFiles.length}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border">
                <span className="text-amber-500 flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5" /> Sign type docs
                </span>
                <span className="font-mono font-medium text-foreground">{signageDocFiles.length}</span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-muted-foreground">Total</span>
                <span className="font-mono font-medium text-foreground">{totalCount}</span>
              </div>

              {signageDocFiles.length > 0 && (
                <div className="mt-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
                  Sign type library pre-pass enabled — Gemini will extract type codes, dimensions, and ADA properties before scanning plan files.
                </div>
              )}

              {planFiles.length === 0 && (
                <p className="text-xs text-muted-foreground text-center pt-4">
                  Add at least one plan document to start an extraction job.
                </p>
              )}
            </div>

            <div className="pt-4 mt-4 border-t border-border">
              <Button
                onClick={handleUpload}
                disabled={planFiles.length === 0 || uploadMutation.isPending}
                size="lg"
                className="w-full font-display font-semibold uppercase tracking-wider shadow-[0_0_20px_rgba(255,170,0,0.12)] hover:shadow-[0_0_25px_rgba(255,170,0,0.22)]"
              >
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <UploadCloud className="w-4 h-4" />
                    Upload & Scan
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
