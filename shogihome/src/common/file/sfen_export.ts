export interface KifuSearchQuery {
  sfen?: string;
  keyword?: string;
  player1?: string;
  player2?: string;
  isStrictTurn?: boolean;
  startDate?: string;
}

export interface SfenExportRequest {
  filename: string;
  search: KifuSearchQuery;
  maxMoves?: number;
  standardInitialOnly: boolean;
  overwrite: boolean;
}

export type SfenExportJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SfenExportJobStatus {
  jobId: string;
  state: SfenExportJobState;
  outputPath: string;
  totalFiles: number;
  processedFiles: number;
  exportedLines: number;
  failedFiles: number;
  error?: string;
}
