import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useDropzone } from "react-dropzone";
import { UploadCloud, FileText, X, ChevronRight, AlertCircle } from "lucide-react";
import { AppShell } from "@/components/layout/Shell";
import { useUploadJobFiles } from "@/hooks/use-takeoff";
import { formatBytes } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

export default function Home() {
  const [, setLocation] = useLocation();
  const [files, setFiles] = useState<File[]>([]);
  const uploadMutation = useUploadJobFiles();

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFiles(prev => [...prev, ...acceptedFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: {
      'application/pdf': ['.pdf']
    }
  });

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    
    try {
      const result = await uploadMutation.mutateAsync({ 
        data: { files } 
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
          <div className="lg:col-span-2 space-y-6">
            <div 
              {...getRootProps()} 
              className={`
                relative overflow-hidden
                border-2 border-dashed rounded-xl p-12
                flex flex-col items-center justify-center text-center
                transition-all duration-300 cursor-pointer min-h-[300px]
                ${isDragActive ? 'border-primary bg-primary/5' : 'border-border bg-card'}
              `}
            >
              <input {...getInputProps()} />

              <div className={`p-4 rounded-full mb-4 transition-colors duration-300 ${isDragActive ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                <UploadCloud className="w-8 h-8" />
              </div>
              
              <h3 className="text-lg font-medium text-foreground mb-1 font-display">
                {isDragActive ? "Drop PDFs here..." : "Drag & Drop PDFs"}
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                or click to browse from your computer. Only .pdf files are supported.
              </p>
            </div>

            {/* Error Messages */}
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

          {/* Sidebar / File List */}
          <div className="bg-card rounded-xl border border-border p-6 flex flex-col h-[400px] lg:h-auto">
            <h3 className="font-display font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-4">
              Selected Files ({files.length})
            </h3>
            
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 scrollbar-industrial">
              <AnimatePresence>
                {files.length === 0 && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-sm text-muted-foreground text-center py-8"
                  >
                    No files selected yet.
                  </motion.div>
                )}
                
                {files.map((file, i) => (
                  <motion.div
                    key={`${file.name}-${i}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="flex items-center gap-3 p-3 rounded-lg bg-secondary border border-border/50"
                  >
                    <FileText className="w-5 h-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate font-medium">
                        {file.name}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        {formatBytes(file.size)}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFile(i);
                      }}
                      className="p-1.5 rounded-md text-muted-foreground transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <div className="pt-4 mt-4 border-t border-border">
              <button
                onClick={handleUpload}
                disabled={files.length === 0 || uploadMutation.isPending}
                className={`
                  w-full py-3 px-4 rounded-lg font-display font-semibold uppercase tracking-wider text-sm flex items-center justify-center gap-2 transition-all duration-300
                  ${files.length > 0 && !uploadMutation.isPending
                    ? "bg-primary text-primary-foreground" 
                    : "bg-secondary text-muted-foreground cursor-not-allowed"}
                `}
              >
                {uploadMutation.isPending ? (
                  <>
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    Upload & Scan
                    <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
