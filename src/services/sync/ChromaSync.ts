
import { ChromaMcpManager } from './ChromaMcpManager.js';
import { ChromaSyncState, ProjectWatermarks } from './ChromaSyncState.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
// cmem-sdk: keep SessionStore + parseFileList off the SDK's import graph.
// Both come from the SQLite layer (`bun:sqlite`). The SDK never calls the
// SQLite-only methods of ChromaSync, so a TYPE-ONLY import is sufficient —
// the value-level use (parseFileList(...)) is loaded lazily inside the
// methods that need it. Plan §3 anti-pattern: do NOT add `bun:sqlite` to
// the SDK bundle externals — fix the import chain.
import type { SessionStore as SessionStoreType } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { ChromaUnavailableError } from '../worker/search/errors.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import type * as SqliteFilesModule from '../sqlite/observations/files.js';

type SessionStore = SessionStoreType;

// Lazy CJS require so tsup (used by the cmem-sdk build) does not follow
// these SQLite-coupled modules into the SDK bundle. Worker/Bun runtime
// reaches them at first call; the SDK never calls the methods that
// trigger these loads, so they never load in SDK consumers.
const lazyCreateRequire = (): ((id: string) => unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('module') as typeof import('module');
  return mod.createRequire(import.meta.url);
};

let _filesHelper: typeof SqliteFilesModule | undefined;
function loadFilesHelper(): typeof SqliteFilesModule {
  if (!_filesHelper) {
    const req = lazyCreateRequire();
    _filesHelper = req('../sqlite/observations/files.js') as typeof SqliteFilesModule;
  }
  return _filesHelper;
}

// Exported for cmem-sdk Phase 6: the SDK builds ChromaDocument values from
// Postgres observations (UUID id, content string, metadata bag) and calls
// the now-public addDocuments() to index them. Shape is unchanged.
export interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

export interface MergedIntoProjectTarget {
  docType: 'observation' | 'session_summary';
  sqliteId: number;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source?: string | null;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null; 
  narrative: string | null;
  concepts: string | null; 
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source?: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface StoredUserPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
  memory_session_id: string;
  project: string;
  platform_source: string;
}

export class ChromaSync {
  private project: string;
  private collectionName: string;
  private collectionCreated = false;
  // 50 documents is roughly 20s of embedding against a large persistent
  // collection — comfortably inside the MCP request timeout, where 100 sat
  // right on it and tipped over whenever live sync competed for the same
  // subprocess.
  private readonly BATCH_SIZE = 50;

  /** Consecutive writes that land nothing before a backfill run gives up. */
  private static readonly MAX_DEAD_BATCHES = 3;

  constructor(project: string) {
    this.project = project;
    const sanitized = project
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/[^a-zA-Z0-9]+$/, '');  
    this.collectionName = `cm__${sanitized || 'unknown'}`;
  }

  /** Public: cmem-sdk reuses the per-tenant collection name for raw queries. */
  public getCollectionName(): string {
    return this.collectionName;
  }

  // Public: cmem-sdk requires Chroma at construction. Plan §3 line 192.
  public async ensureCollectionExists(): Promise<void> {
    if (this.collectionCreated) {
      return;
    }

    const chromaMcp = ChromaMcpManager.getInstance();
    try {
      await chromaMcp.callTool('chroma_create_collection', {
        collection_name: this.collectionName
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        throw error;
      }
      // Collection already exists - this is the expected path after first creation
    }

    this.collectionCreated = true;

    logger.debug('CHROMA_SYNC', 'Collection ready', {
      collection: this.collectionName
    });
  }

  private formatObservationDocs(obs: StoredObservation): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    // parseFileList is SQLite-shaped (`bun:sqlite` in the import chain) —
    // resolve it through the deferred loader so this method stays out of
    // the SDK bundle's import graph. Plan §3.
    const filesHelper = loadFilesHelper();
    const files_read = filesHelper.parseFileList(obs.files_read);
    const files_modified = filesHelper.parseFileList(obs.files_modified);

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      merged_into_project: obs.merged_into_project ?? null,
      platform_source: obs.platform_source
        ? normalizePlatformSource(obs.platform_source)
        : normalizePlatformSource(undefined),
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

    if (obs.subtitle) {
      baseMetadata.subtitle = obs.subtitle;
    }
    if (concepts.length > 0) {
      baseMetadata.concepts = concepts.join(',');
    }
    if (files_read.length > 0) {
      baseMetadata.files_read = files_read.join(',');
    }
    if (files_modified.length > 0) {
      baseMetadata.files_modified = files_modified.join(',');
    }

    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    return documents;
  }

  private formatSummaryDocs(summary: StoredSummary): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      merged_into_project: summary.merged_into_project ?? null,
      platform_source: summary.platform_source
        ? normalizePlatformSource(summary.platform_source)
        : normalizePlatformSource(undefined),
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    if (summary.request) {
      documents.push({
        id: `summary_${summary.id}_request`,
        document: summary.request,
        metadata: { ...baseMetadata, field_type: 'request' }
      });
    }

    if (summary.investigated) {
      documents.push({
        id: `summary_${summary.id}_investigated`,
        document: summary.investigated,
        metadata: { ...baseMetadata, field_type: 'investigated' }
      });
    }

    if (summary.learned) {
      documents.push({
        id: `summary_${summary.id}_learned`,
        document: summary.learned,
        metadata: { ...baseMetadata, field_type: 'learned' }
      });
    }

    if (summary.completed) {
      documents.push({
        id: `summary_${summary.id}_completed`,
        document: summary.completed,
        metadata: { ...baseMetadata, field_type: 'completed' }
      });
    }

    if (summary.next_steps) {
      documents.push({
        id: `summary_${summary.id}_next_steps`,
        document: summary.next_steps,
        metadata: { ...baseMetadata, field_type: 'next_steps' }
      });
    }

    if (summary.notes) {
      documents.push({
        id: `summary_${summary.id}_notes`,
        document: summary.notes,
        metadata: { ...baseMetadata, field_type: 'notes' }
      });
    }

    return documents;
  }

  /**
   * Write `documents` to Chroma in BATCH_SIZE-sized batches.
   *
   * Returns the number of documents that were successfully written (or
   * confirmed via delete+add reconcile). Per-batch failures are logged and the
   * loop continues — we never throw — so callers must use the returned count
   * to advance their watermark, otherwise an interrupted backfill can mark
   * unsynced records as synced.
   *
   * Visibility: promoted from `private` to `public` for cmem-sdk Phase 6.
   * The SDK indexes Postgres observations into Chroma using this same
   * storage-agnostic document layer — same retry/dedupe semantics, same
   * BATCH_SIZE. SQLite-shaped `syncObservation` is NOT reusable for the
   * Postgres UUID path. See plan §6 line 244-247.
   */
  public async addDocuments(documents: ChromaDocument[]): Promise<number> {
    if (documents.length === 0) {
      return 0;
    }

    try {
      await this.ensureCollectionExists();
    } catch (error) {
      if (error instanceof ChromaUnavailableError) {
        logger.warn('CHROMA_SYNC', 'Chroma unavailable before write; leaving documents unsynced', {
          collection: this.collectionName,
          requested: documents.length,
          error: error.message
        });
        return 0;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('CHROMA_SYNC', 'Unexpected error ensuring collection before write', {
        collection: this.collectionName,
        requested: documents.length
      }, err);
      throw error;
    }

    const chromaMcp = ChromaMcpManager.getInstance();

    let written = 0;
    for (let i = 0; i < documents.length; i += this.BATCH_SIZE) {
      const batch = documents.slice(i, i + this.BATCH_SIZE);

      const cleanMetadatas = batch.map(d =>
        Object.fromEntries(
          Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
        )
      );

      try {
        await chromaMcp.callTool('chroma_add_documents', {
          collection_name: this.collectionName,
          ids: batch.map(d => d.id),
          documents: batch.map(d => d.document),
          metadatas: cleanMetadatas
        });
        written += batch.length;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('already exist')) {
          try {
            // Reconcile without delete+add. Document IDs are deterministic
            // (e.g. obs_<sqlite_id>_narrative), so every resync, backfill,
            // retry, or interruption collides on the same IDs. HNSW deletions
            // are soft-deletes: a delete+add cycle leaves the old graph nodes
            // in link_lists.bin while appending new ones, so the on-disk index
            // grows without bound and can exhaust disk/RAM.
            //
            // chroma_add_documents rejects the WHOLE batch when any single ID
            // already exists, so a mixed batch may contain both colliding IDs
            // and genuinely-new IDs. chroma_update_documents silently ignores
            // IDs that are not already present, so a blanket update would
            // overwrite the duplicates but never insert the new docs — while
            // still advancing the watermark past them (data loss). So split
            // the batch: update the existing IDs in place, add only the new
            // ones, and count each part only if it actually succeeds.
            const existing = await chromaMcp.callTool('chroma_get_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id),
              include: []
            }) as { ids?: string[] };
            const existingIds = new Set(existing?.ids ?? []);

            const toUpdate = batch.filter(d => existingIds.has(d.id));
            const toAdd = batch.filter(d => !existingIds.has(d.id));
            const cleanFor = (docs: ChromaDocument[]) => docs.map(d =>
              Object.fromEntries(
                Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
              )
            );

            if (toUpdate.length > 0) {
              await chromaMcp.callTool('chroma_update_documents', {
                collection_name: this.collectionName,
                ids: toUpdate.map(d => d.id),
                documents: toUpdate.map(d => d.document),
                metadatas: cleanFor(toUpdate)
              });
              written += toUpdate.length;
            }

            if (toAdd.length > 0) {
              await chromaMcp.callTool('chroma_add_documents', {
                collection_name: this.collectionName,
                ids: toAdd.map(d => d.id),
                documents: toAdd.map(d => d.document),
                metadatas: cleanFor(toAdd)
              });
              written += toAdd.length;
            }

            logger.info('CHROMA_SYNC', 'Batch reconciled via in-place update + add after duplicate conflict', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length,
              updated: toUpdate.length,
              added: toAdd.length
            });
          } catch (reconcileError) {
            logger.error('CHROMA_SYNC', 'Batch reconcile (update+add) failed — watermark will not advance for this batch', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            }, reconcileError as Error);
          }
        } else {
          logger.error('CHROMA_SYNC', 'Batch add failed — watermark will not advance for this batch, continuing with remaining batches', {
            collection: this.collectionName,
            batchStart: i,
            batchSize: batch.length
          }, error as Error);
        }
      }
    }

    logger.debug('CHROMA_SYNC', 'Documents added', {
      collection: this.collectionName,
      requested: documents.length,
      written
    });
    return written;
  }

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project: project,
      merged_into_project: null,
      platform_source: platformSource ? normalizePlatformSource(platformSource) : normalizePlatformSource(undefined),
      text: null, // Legacy field, not used
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      prompt_number: promptNumber,
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatObservationDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing observation', {
      observationId,
      documentCount: documents.length,
      project
    });

    // Only advance the watermark on a confirmed full write. addDocuments() now
    // returns a written count and tolerates per-batch failures, so a transient
    // Chroma error must NOT mark this observation as synced — otherwise the
    // backfill pass on next boot will skip past it (CodeRabbit review on PR
    // #2282).
    const written = await this.addDocuments(documents);
    if (written === documents.length) {
      ChromaSyncState.bump(project, 'observations', observationId);
    } else {
      logger.warn('CHROMA_SYNC', 'Observation watermark bump skipped — partial write', {
        observationId,
        project,
        requested: documents.length,
        written
      });
    }
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project: project,
      merged_into_project: null,
      platform_source: platformSource ? normalizePlatformSource(platformSource) : normalizePlatformSource(undefined),
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      prompt_number: promptNumber,
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatSummaryDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing summary', {
      summaryId,
      documentCount: documents.length,
      project
    });

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const written = await this.addDocuments(documents);
    if (written === documents.length) {
      ChromaSyncState.bump(project, 'summaries', summaryId);
    } else {
      logger.warn('CHROMA_SYNC', 'Summary watermark bump skipped — partial write', {
        summaryId,
        project,
        requested: documents.length,
        written
      });
    }
  }

  private formatUserPromptDoc(prompt: StoredUserPrompt): ChromaDocument {
    return {
      id: `prompt_${prompt.id}`,
      document: prompt.prompt_text,
      metadata: {
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        memory_session_id: prompt.memory_session_id,
        project: prompt.project,
        platform_source: prompt.platform_source,
        created_at_epoch: prompt.created_at_epoch,
        prompt_number: prompt.prompt_number
      }
    };
  }

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    const stored: StoredUserPrompt = {
      id: promptId,
      content_session_id: '', // Not needed for Chroma sync
      prompt_number: promptNumber,
      prompt_text: promptText,
      created_at_epoch: createdAtEpoch,
      memory_session_id: memorySessionId,
      project: project,
      platform_source: normalizePlatformSource(platformSource)
    };

    const document = this.formatUserPromptDoc(stored);

    logger.info('CHROMA_SYNC', 'Syncing user prompt', {
      promptId,
      project
    });

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const written = await this.addDocuments([document]);
    if (written === 1) {
      ChromaSyncState.bump(project, 'prompts', promptId);
    } else {
      logger.warn('CHROMA_SYNC', 'Prompt watermark bump skipped — write failed', {
        promptId,
        project,
        written
      });
    }
  }

  private mergeRowsById<T extends { id: number }>(rows: T[], pendingRows: T[]): T[] {
    const merged = new Map<number, T>();
    for (const row of rows) {
      merged.set(row.id, row);
    }
    for (const row of pendingRows) {
      merged.set(row.id, row);
    }
    return [...merged.values()].sort((a, b) => a.id - b.id);
  }

  private summarizeBootstrapPending(
    sourceIds: number[],
    existingIds: Set<number>
  ): { watermark: number; pending: number[] } {
    const watermark = existingIds.size ? Math.max(...existingIds) : 0;
    return {
      watermark,
      pending: sourceIds.filter(id => id <= watermark && !existingIds.has(id)),
    };
  }

  private async getExistingChromaIds(project: string): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
  }> {
    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000; 

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { project });

    while (true) {
      const result = await chromaMcp.callTool('chroma_get_documents', {
        collection_name: this.collectionName,
        limit: limit,
        offset: offset,
        where: { project },
        include: ['metadatas']
      }) as any;

      const metadatas = result?.metadatas || [];

      if (metadatas.length === 0) {
        break; 
      }

      for (const meta of metadatas) {
        if (meta && meta.sqlite_id) {
          const sqliteId = meta.sqlite_id as number;
          if (meta.doc_type === 'observation') {
            observationIds.add(sqliteId);
          } else if (meta.doc_type === 'session_summary') {
            summaryIds.add(sqliteId);
          } else if (meta.doc_type === 'user_prompt') {
            promptIds.add(sqliteId);
          }
        }
      }

      offset += limit;

      logger.debug('CHROMA_SYNC', 'Fetched batch of existing IDs', {
        project,
        offset,
        batchSize: metadatas.length
      });
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      project,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size,
      total: observationIds.size + summaryIds.size + promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  async bootstrapWatermarksFromChroma(project: string, store: SessionStore): Promise<void> {
    const existing = await this.getExistingChromaIds(project);
    const observationIds = store.db.prepare(`
      SELECT id
      FROM observations
      WHERE project = ?
      ORDER BY id ASC
    `).all(project) as Array<{ id: number }>;
    const summaryIds = store.db.prepare(`
      SELECT id
      FROM session_summaries
      WHERE project = ?
      ORDER BY id ASC
    `).all(project) as Array<{ id: number }>;
    const promptIds = store.db.prepare(`
      SELECT up.id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ?
      ORDER BY up.id ASC
    `).all(project) as Array<{ id: number }>;
    const observationBootstrap = this.summarizeBootstrapPending(observationIds.map(row => row.id), existing.observations);
    const summaryBootstrap = this.summarizeBootstrapPending(summaryIds.map(row => row.id), existing.summaries);
    const promptBootstrap = this.summarizeBootstrapPending(promptIds.map(row => row.id), existing.prompts);

    ChromaSyncState.replace(project, {
      observations: observationBootstrap.watermark,
      summaries: summaryBootstrap.watermark,
      prompts: promptBootstrap.watermark,
      pending: {
        observations: observationBootstrap.pending,
        summaries: summaryBootstrap.pending,
        prompts: promptBootstrap.pending,
      }
    });
    logger.info('CHROMA_SYNC', 'Bootstrapped watermarks from Chroma', {
      project,
      watermarks: ChromaSyncState.get(project)
    });
  }

  async ensureBackfilled(project: string, store: SessionStore): Promise<void> {
    logger.info('CHROMA_SYNC', 'Starting smart backfill', { project });

    await this.ensureCollectionExists();

    const watermarks = ChromaSyncState.get(project);

    try {
      await this.runBackfillPipeline(store, project, watermarks);
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Backfill failed', { project }, error instanceof Error ? error : new Error(String(error)));
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runBackfillPipeline(
    db: SessionStore,
    backfillProject: string,
    watermarks: ProjectWatermarks
  ): Promise<void> {
    const observationDocs = await this.backfillObservations(db, backfillProject, watermarks.observations);
    const summaryDocs = await this.backfillSummaries(db, backfillProject, watermarks.summaries);
    const promptDocs = await this.backfillPrompts(db, backfillProject, watermarks.prompts);

    logger.info('CHROMA_SYNC', 'Smart backfill complete', {
      project: backfillProject,
      synced: { observationDocs, summaryDocs, promptDocs },
      watermarks: ChromaSyncState.get(backfillProject)
    });
  }

  /**
   * Shared batch/watermark loop for all three backfill kinds. Returns the
   * number of documents produced from `rows`.
   *
   * Watermark durability is row-atomic, not batch-atomic: one observation or
   * summary can expand into several Chroma documents and span multiple
   * BATCH_SIZE writes. We only clear pending state and bump the row watermark
   * after every document for that row lands, otherwise a later batch failure or
   * restart can strand the tail of a split row forever.
   */
  private async backfillKind<T extends { id: number }>(
    rows: T[],
    formatDocs: (row: T) => ChromaDocument[],
    kind: 'observations' | 'summaries' | 'prompts',
    backfillProject: string
  ): Promise<number> {
    const rowsWithDocs = rows
      .map(row => ({ row, docs: formatDocs(row) }))
      .filter(({ docs }) => docs.length > 0);
    const totalDocs = rowsWithDocs.reduce((sum, { docs }) => sum + docs.length, 0);
    let processedDocs = 0;

    // Pack whole rows into one write per BATCH_SIZE documents. A row is only
    // 3-6 documents, and a Chroma add against a large persistent collection
    // costs about the same round-trip whether it carries 4 documents or 100 —
    // so a row-per-call backfill of a large gap runs for days. Rows are never
    // split across writes here, which keeps the row-atomic rule above intact: a
    // fully written batch means every row in it is complete.
    let batch: ChromaDocument[] = [];
    let batchRows: T[] = [];
    let deadBatches = 0;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }

      const written = await this.addDocuments(batch);
      processedDocs += batch.length;

      // addDocuments() logs and swallows per-batch failures so one bad batch
      // cannot stop the run — but when Chroma itself is down every batch fails
      // instantly, and a large gap marches through thousands of rows in under a
      // minute, marks them all pending, and reports "backfill complete". Give
      // up after a few writes land nothing at all and let the next run retry.
      deadBatches = written === 0 ? deadBatches + 1 : 0;
      if (deadBatches >= ChromaSync.MAX_DEAD_BATCHES) {
        ChromaSyncState.markPending(backfillProject, kind, batchRows.map(({ id }) => id));
        throw new Error(
          `Chroma wrote nothing for ${deadBatches} consecutive batches (${kind}, project ${backfillProject}) — aborting backfill`
        );
      }

      // Only advance the watermark for documents that actually landed in
      // Chroma. addDocuments() logs and continues on per-batch failures, so a
      // partial write must not mark unwritten docs as synced. Which row lost
      // which document is not reported back, so the whole batch stays pending —
      // the retry re-adds the rows that did land, which is an in-place update.
      if (written < batch.length) {
        ChromaSyncState.markPending(backfillProject, kind, batchRows.map(({ id }) => id));
        logger.debug('CHROMA_SYNC', 'Recorded pending watermark gap for failed/partial batch', {
          project: backfillProject,
          kind,
          rowIds: batchRows.map(({ id }) => id),
          requested: batch.length,
          written
        });
      } else {
        for (const { id } of batchRows) {
          ChromaSyncState.clearPending(backfillProject, kind, [id]);
          ChromaSyncState.bump(backfillProject, kind, id);
        }

        logger.debug('CHROMA_SYNC', 'Backfill progress', {
          project: backfillProject,
          progress: `${Math.min(processedDocs, totalDocs)}/${totalDocs}`
        });
      }

      batch = [];
      batchRows = [];
    };

    for (const { row, docs } of rowsWithDocs) {
      if (batch.length > 0 && batch.length + docs.length > this.BATCH_SIZE) {
        await flush();
      }

      batch.push(...docs);
      batchRows.push(row);

      // A single row wider than BATCH_SIZE still goes out alone; addDocuments()
      // chunks it internally and reports one written count for the whole row.
      if (batch.length >= this.BATCH_SIZE) {
        await flush();
      }
    }

    await flush();

    return totalDocs;
  }

  private async backfillObservations(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<number> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'observations');
    const observations = db.db.prepare(`
      SELECT
        o.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.project = ? AND o.id > ?
      ORDER BY o.id ASC
    `).all(backfillProject, watermark) as StoredObservation[];
    let pendingRows: StoredObservation[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          o.*,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM observations o
        LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
        WHERE o.project = ? AND o.id IN (${placeholders})
        ORDER BY o.id ASC
      `).all(backfillProject, ...pendingIds) as StoredObservation[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'observations', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(observations, pendingRows);

    if (rows.length === 0) {
      return 0;
    }

    const totalObsCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling observations', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalObsCount.count
    });

    return this.backfillKind(rows, obs => this.formatObservationDocs(obs), 'observations', backfillProject);
  }

  private async backfillSummaries(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<number> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'summaries');
    const summaries = db.db.prepare(`
      SELECT
        ss.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.project = ? AND ss.id > ?
      ORDER BY ss.id ASC
    `).all(backfillProject, watermark) as StoredSummary[];
    let pendingRows: StoredSummary[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          ss.*,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM session_summaries ss
        LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
        WHERE ss.project = ? AND ss.id IN (${placeholders})
        ORDER BY ss.id ASC
      `).all(backfillProject, ...pendingIds) as StoredSummary[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'summaries', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(summaries, pendingRows);

    if (rows.length === 0) {
      return 0;
    }

    const totalSummaryCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling summaries', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalSummaryCount.count
    });

    return this.backfillKind(rows, summary => this.formatSummaryDocs(summary), 'summaries', backfillProject);
  }

  private async backfillPrompts(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<number> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'prompts');
    const prompts = db.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ? AND up.id > ?
      ORDER BY up.id ASC
    `).all(backfillProject, watermark) as StoredUserPrompt[];
    let pendingRows: StoredUserPrompt[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        WHERE s.project = ? AND up.id IN (${placeholders})
        ORDER BY up.id ASC
      `).all(backfillProject, ...pendingIds) as StoredUserPrompt[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'prompts', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(prompts, pendingRows);

    if (rows.length === 0) {
      return 0;
    }

    const totalPromptCount = db.db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalPromptCount.count
    });

    return this.backfillKind(rows, prompt => [this.formatUserPromptDoc(prompt)], 'prompts', backfillProject);
  }

  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    await this.ensureCollectionExists();

    let results: any;
    try {
      const chromaMcp = ChromaMcpManager.getInstance();
      results = await chromaMcp.callTool('chroma_query_documents', {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: limit,
        ...(whereFilter && { where: whereFilter }),
        include: ['documents', 'metadatas', 'distances']
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') || // [ANTI-PATTERN IGNORED]: ChromaMcpManager.callTool re-wraps transport failures as plain Errors, so the Node error code only survives in the message text; the full error object is logged below.
        errorMessage.includes('ENOTFOUND') || // [ANTI-PATTERN IGNORED]: same MCP transport re-wrapping as above; no structured code field is available on the re-wrapped error.
        errorMessage.includes('fetch failed') || 
        errorMessage.includes('subprocess closed') || 
        errorMessage.includes('timed out'); 

      if (isConnectionError) {
        this.collectionCreated = false;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }

      logger.error('CHROMA_SYNC', 'Query failed', { project: this.project, query }, error as Error);
      throw error;
    }

    return this.deduplicateQueryResults(results);
  }

  private deduplicateQueryResults(results: any): { ids: number[]; distances: number[]; metadatas: any[] } {
    const ids: number[] = [];
    const seen = new Set<string>();
    const docIds = results?.ids?.[0] || [];
    const rawMetadatas = results?.metadatas?.[0] || [];
    const rawDistances = results?.distances?.[0] || [];

    const metadatas: any[] = [];
    const distances: number[] = [];

    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i];
      const obsMatch = docId.match(/obs_(\d+)_/);
      const summaryMatch = docId.match(/summary_(\d+)_/);
      const promptMatch = docId.match(/prompt_(\d+)/);

      let sqliteId: number | null = null;
      let entityType: string | null = null;
      if (obsMatch) {
        sqliteId = parseInt(obsMatch[1], 10);
        entityType = 'observation';
      } else if (summaryMatch) {
        sqliteId = parseInt(summaryMatch[1], 10);
        entityType = 'session_summary';
      } else if (promptMatch) {
        sqliteId = parseInt(promptMatch[1], 10);
        entityType = 'user_prompt';
      }

      if (sqliteId !== null && entityType) {
        const dedupeKey = `${entityType}:${sqliteId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        ids.push(sqliteId);
        metadatas.push(rawMetadatas[i] ?? null);
        distances.push(rawDistances[i] ?? 0);
      }
    }

    return { ids, distances, metadatas };
  }

  /** Maximum number of concurrent project backfills to run at once. */
  private static readonly BACKFILL_CONCURRENCY_LIMIT = 3;

  /** Passes over the failing projects before a run gives up until next start. */
  private static readonly BACKFILL_MAX_ATTEMPTS = 12;

  /** Long enough to outlast the connection backoff and a brief network outage. */
  private static readonly BACKFILL_RETRY_DELAY_MS = 5 * 60 * 1000;

  /** Guard flag to prevent overlapping backfill runs from fire-and-forget callers. */
  private static backfillInProgress = false;

  /**
   * Backfill all projects that have observations in SQLite but may be missing from Chroma.
   * Uses a single shared ChromaSync('claude-mem') instance and Chroma connection.
   * Per-project scoping is passed as a parameter to ensureBackfilled(), avoiding
   * instance state mutation. All documents land in the cm__claude-mem collection
   * with project scoped via metadata, matching how DatabaseManager and SearchManager operate.
   * Designed to be called fire-and-forget on worker startup.
   *
   * Concurrency: processes at most BACKFILL_CONCURRENCY_LIMIT projects in parallel
   * to bound CPU and memory pressure from concurrent Chroma embedding operations.
   * A re-entrant guard prevents overlapping backfill runs from accumulating.
   */
  static async backfillAllProjects(store: SessionStore): Promise<void> {
    if (ChromaSync.backfillInProgress) {
      logger.info('CHROMA_SYNC', 'Backfill already in progress, skipping duplicate run');
      return;
    }

    const sync = new ChromaSync('claude-mem');

    ChromaSync.backfillInProgress = true;
    try {
      const projects = store.db.prepare(
        'SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ?'
      ).all('') as { project: string }[];

      logger.info('CHROMA_SYNC', `Backfill check for ${projects.length} projects`);

      // Reconcile against Chroma on EVERY run, not just when the state file is
      // missing. The watermark is a max(): the live syncObservation() path bumps
      // it to the newest id while a backfill is still walking older rows, so it
      // routinely sits above rows that were never embedded. `id > watermark`
      // then skips those rows forever and nothing ever notices — the same hole
      // opens after a Chroma wipe that leaves the state file behind. Chroma is
      // the only source that knows what actually landed, so ask it.
      logger.info('CHROMA_SYNC', 'Reconciling watermarks against Chroma');
      for (const { project } of projects) {
        try {
          await sync.bootstrapWatermarksFromChroma(project, store);
        } catch (error) {
          logger.error('CHROMA_SYNC', `Bootstrap failed for project: ${project}`,
            {}, error instanceof Error ? error : new Error(String(error)));
        }
      }
      logger.info('CHROMA_SYNC', 'Reconcile complete — backfill will fill the recorded gaps');

      // Process projects in chunks of BACKFILL_CONCURRENCY_LIMIT to bound
      // CPU/memory pressure from concurrent Chroma embedding operations.
      // Each chunk runs its projects in parallel; we wait for the entire chunk
      // before starting the next one. Simple and predictable — no semaphore
      // overhead, no unbounded fan-out.
      const concurrency = ChromaSync.BACKFILL_CONCURRENCY_LIMIT;

      // Retry the whole pass while projects are still failing. A large gap
      // needs hours of writes, and any single blip — a request timeout, a uvx
      // prewarm that cannot reach the network — aborts the project it hits.
      // Without this, backfill only runs again at the next worker start, so an
      // unattended repair stops at the first blip and nobody notices.
      // ponytail: fixed attempt count and delay; if the store ever needs more
      // than this, drive the retry off whether the last pass made progress.
      for (let attempt = 1; attempt <= ChromaSync.BACKFILL_MAX_ATTEMPTS; attempt++) {
        const failedProjects: string[] = [];

        for (let i = 0; i < projects.length; i += concurrency) {
          const chunk = projects.slice(i, i + concurrency);
          const chunkResults = await Promise.allSettled(
            chunk.map(({ project }) => sync.ensureBackfilled(project, store))
          );

          for (let j = 0; j < chunkResults.length; j++) {
            const result = chunkResults[j];
            if (result.status === 'rejected') {
              const project = chunk[j].project;
              const error = result.reason;
              failedProjects.push(project);
              if (error instanceof Error) {
                logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, {}, error);
              } else {
                logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, { error: String(error) });
              }
              // Continue to next chunk — don't let one failure stop others
            }
          }
        }

        if (failedProjects.length === 0) {
          break;
        }

        if (attempt === ChromaSync.BACKFILL_MAX_ATTEMPTS) {
          logger.error('CHROMA_SYNC', 'Backfill still failing after the last attempt — giving up until the next worker start', {
            attempt,
            projects: failedProjects
          });
          break;
        }

        logger.warn('CHROMA_SYNC', 'Backfill pass had failures, retrying after a delay', {
          attempt,
          projects: failedProjects,
          retryInMs: ChromaSync.BACKFILL_RETRY_DELAY_MS
        });
        await new Promise(resolve => setTimeout(resolve, ChromaSync.BACKFILL_RETRY_DELAY_MS));
      }
    } finally {
      ChromaSync.backfillInProgress = false;
    }
  }

  async updateMergedIntoProject(
    targets: MergedIntoProjectTarget[],
    mergedIntoProject: string
  ): Promise<void> {
    if (targets.length === 0) return;

    await this.ensureCollectionExists();
    const chromaMcp = ChromaMcpManager.getInstance();

    let totalPatched = 0;

    for (const docType of ['observation', 'session_summary'] as const) {
      const sqliteIds = targets
        .filter(target => target.docType === docType)
        .map(target => target.sqliteId);

      for (let i = 0; i < sqliteIds.length; i += this.BATCH_SIZE) {
        const idBatch = sqliteIds.slice(i, i + this.BATCH_SIZE);

        const existing = await chromaMcp.callTool('chroma_get_documents', {
          collection_name: this.collectionName,
          where: {
            $and: [
              { doc_type: docType },
              { sqlite_id: { $in: idBatch } }
            ]
          },
          include: ['metadatas']
        }) as { ids?: string[]; metadatas?: Array<Record<string, any> | null> };

        const docIds: string[] = existing?.ids ?? [];
        if (docIds.length === 0) continue;

        const metadatas = (existing?.metadatas ?? []).map(m => {
          const merged: Record<string, any> = {
            ...(m ?? {}),
            merged_into_project: mergedIntoProject
          };
          return Object.fromEntries(
            Object.entries(merged).filter(
              ([, v]) => v !== null && v !== undefined && v !== ''
            )
          );
        });

        await chromaMcp.callTool('chroma_update_documents', {
          collection_name: this.collectionName,
          ids: docIds,
          metadatas
        });
        totalPatched += docIds.length;
      }
    }

    logger.info('CHROMA_SYNC', 'merged_into_project metadata patched', {
      collection: this.collectionName,
      mergedIntoProject,
      sqliteIdCount: targets.length,
      chromaDocsPatched: totalPatched
    });
  }
}
