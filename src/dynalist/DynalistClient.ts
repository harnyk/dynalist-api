// dynalist-client.ts
// Single-file TypeScript client for Dynalist API v1
// All comments are in English as requested.

export type DynalistBaseResponse = {
  _code: string;
  _msg?: string;
};

export type DynalistFileType = "document" | "folder";

export enum FilePermission {
  None = 0,
  ReadOnly = 1,
  Edit = 2,
  Manage = 3,
  Owner = 4,
}

export interface FileDescriptor {
  id: string;
  title: string;
  type: DynalistFileType;
  permission: FilePermission;
}

export interface FileListResponse extends DynalistBaseResponse {
  files: FileDescriptor[];
}

// --- file/edit changes ---
export type FileEditMove = {
  action: "move";
  type: DynalistFileType;
  file_id: string;
  parent_id: string;
  index: number; // 0-based position within parent
};

export type FileEditEdit = {
  action: "edit";
  type: DynalistFileType;
  file_id: string;
  title: string;
};

export type FileEditCreate = {
  action: "create";
  type: DynalistFileType;
  parent_id: string;
  index: number;
  title?: string; // title is optional per docs for some create ops
};

export type FileEditChange = FileEditMove | FileEditEdit | FileEditCreate;

export interface FileEditResponse extends DynalistBaseResponse {
  results?: boolean[]; // per-change success
  created?: string[]; // created ids (if any)
}

// --- doc/read ---
export type NodeColor = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type NodeHeading = 0 | 1 | 2 | 3;

export interface DocNode {
  id: string;
  content?: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: NodeHeading;
  color?: NodeColor;
  created?: number; // ms since epoch
  modified?: number; // ms since epoch
  collapsed?: boolean;
  children?: string[]; // child node ids
  // In some responses children may inline nodes; we intentionally type ids only for simplicity.
}

export interface DocReadResponse extends DynalistBaseResponse {
  file_id: string;
  title: string;
  version: number;
  nodes: DocNode[];
}

export interface DocCheckForUpdatesResponse extends DynalistBaseResponse {
  versions: Record<string, number>; // file_id -> version
}

// --- doc/edit changes ---
export type DocInsert = {
  action: "insert";
  parent_id: string;
  index: number;
  content: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: NodeHeading;
  color?: NodeColor;
};

export type DocEdit = {
  action: "edit";
  node_id: string;
  content?: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: NodeHeading;
  color?: NodeColor;
};

export type DocMove = {
  action: "move";
  node_id: string;
  parent_id: string;
  index: number;
};

export type DocDelete = {
  action: "delete";
  node_id: string;
};

export type DocEditChange = DocInsert | DocEdit | DocMove | DocDelete;

export interface DocEditResponse extends DynalistBaseResponse {
  results?: boolean[];
  new_node_ids?: string[]; // only for inserts, mirrors positions of insert ops
}

// --- inbox/add ---
export type PrefKey = "inbox_location" | "inbox_move_position";

export interface InboxAddRequest {
  index?: number; // -1 append, 0 top; default per user pref
  content?: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: NodeHeading;
  color?: NodeColor;
}

export interface InboxAddResponse extends DynalistBaseResponse {
  file_id: string;
  node_id: string;
  index: number;
}

// --- upload ---
export interface UploadRequest {
  filename: string;
  content_type: string;
  data: string; // base64
}

export interface UploadResponse extends DynalistBaseResponse {
  url: string;
}

export interface PrefGetResponse extends DynalistBaseResponse {
  key: PrefKey;
  value: string;
}

export interface DynalistClientOptions {
  token: string;
  baseUrl?: string; // default https://dynalist.io
  userAgent?: string;
  maxRetries?: number; // default 3
  timeoutMs?: number; // per-request timeout
  fetchFn?: typeof fetch; // for testing or custom polyfill
}

/**
 * Minimal, dependency-free Dynalist API client with retries and timeouts.
 */
export class DynalistClient {
  private token: string;
  private baseUrl: string;
  private userAgent?: string;
  private maxRetries: number;
  private timeoutMs?: number;
  private fetchFn: typeof fetch;

  constructor(opts: DynalistClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://dynalist.io").replace(/\/$/, "");
    this.userAgent = opts.userAgent;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.timeoutMs = opts.timeoutMs;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
    if (!this.fetchFn) {
      throw new Error(
        "No fetch implementation found. Provide opts.fetchFn or use Node 18+/modern browsers."
      );
    }
  }

  // --------------- Public API methods ---------------

  /** List all files (documents and folders). */
  async fileList(): Promise<FileListResponse> {
    return this.post<FileListResponse>("/api/v1/file/list", {});
  }

  /** Batch edit documents/folders (move/edit/create). */
  async fileEdit(changes: FileEditChange[]): Promise<FileEditResponse> {
    return this.post<FileEditResponse>("/api/v1/file/edit", { changes });
  }

  /** Read entire document by file_id. */
  async docRead(file_id: string): Promise<DocReadResponse> {
    return this.post<DocReadResponse>("/api/v1/doc/read", { file_id });
  }

  /** Check latest versions for a list of file ids. */
  async docCheckForUpdates(file_ids: string[]): Promise<DocCheckForUpdatesResponse> {
    return this.post<DocCheckForUpdatesResponse>("/api/v1/doc/check_for_updates", { file_ids });
  }

  /** Edit document content with a batch of changes. */
  async docEdit(file_id: string, changes: DocEditChange[]): Promise<DocEditResponse> {
    return this.post<DocEditResponse>("/api/v1/doc/edit", { file_id, changes });
  }

  /** Add an item to the user's inbox. */
  async inboxAdd(req: InboxAddRequest): Promise<InboxAddResponse> {
    return this.post<InboxAddResponse>("/api/v1/inbox/add", { ...req });
  }

  /** Upload a file (Dynalist Pro required). */
  async upload(req: UploadRequest): Promise<UploadResponse> {
    return this.post<UploadResponse>("/api/v1/upload", { ...req });
  }

  /** Get a user preference value. */
  async prefGet(key: PrefKey): Promise<PrefGetResponse> {
    return this.post<PrefGetResponse>("/api/v1/pref/get", { key });
  }

  /** Set a user preference value. */
  async prefSet(key: PrefKey, value: string): Promise<DynalistBaseResponse> {
    return this.post<DynalistBaseResponse>("/api/v1/pref/set", { key, value });
  }

  // --------------- Internal helpers ---------------

  private async post<T extends DynalistBaseResponse>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = this.baseUrl + path;
    const payload = JSON.stringify({ token: this.token, ...body });

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      const controller = this.timeoutMs ? new AbortController() : undefined;
      const timeoutId = this.timeoutMs
        ? setTimeout(() => controller!.abort(), this.timeoutMs)
        : undefined;
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
          },
          body: payload,
          signal: controller?.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        // Retry on 429 and 5xx
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          lastError = new Error(`HTTP ${res.status}`);
          await this.delay(this.backoffMs(attempt));
          attempt++;
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText} ${text}`.trim());
        }

        const json = (await res.json()) as T;
        this.assertOk(json);
        return json;
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        // Retry network errors & aborts up to maxRetries
        if (attempt < this.maxRetries && this.isRetriableError(err)) {
          lastError = err;
          await this.delay(this.backoffMs(attempt));
          attempt++;
          continue;
        }
        throw err;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private assertOk(resp: DynalistBaseResponse) {
    // Dynalist uses `_code: "Ok"` on success; be tolerant to case variations.
    const ok = String(resp._code || "").toLowerCase() === "ok";
    if (!ok) {
      const code = resp._code || "Unknown";
      const msg = resp._msg || "Unknown error";
      console.error('Dynalist API error response:', { code, msg, response: resp });
      const err = new Error(`[Dynalist API] ${code}: ${msg}`);
      (err as any).code = code;
      (err as any).dynalistCode = code;
      (err as any).dynalistMessage = msg;
      throw err;
    }
  }

  private isRetriableError(err: unknown): boolean {
    if (!err) return false;
    const msg = String((err as any).message || err);
    // Network-ish or abort-related errors
    return (
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("ECONNRESET") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("AbortError")
    );
  }

  private backoffMs(attempt: number): number {
    // Exponential backoff with jitter: base 300ms
    const base = 300 * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * 150);
    return base + jitter;
    }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}