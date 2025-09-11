// dynalist-service.ts
// High-level service around DynalistClient for shopping lists.
// Adds per-document mutex + batch inserts to avoid race conditions.

import {
    DynalistClient,
    FileDescriptor,
    DocNode,
    DocReadResponse,
    DocEditChange,
} from './DynalistClient.js';
export type ListInfo = Pick<FileDescriptor, 'id' | 'title' | 'type'>;

export type ShoppingItem = {
    id: string;
    content: string;
    note: string | undefined;
    checked: boolean;
    _node: DocNode | undefined;
};

export type AddItemOptions = {
    note?: string;
    checked?: boolean;
    checkbox?: boolean;
    heading?: 0 | 1 | 2 | 3;
    color?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    position?: 'top' | 'bottom'; // default: bottom
};

/** Tiny async mutex keyed per document id */
class PerDocMutex {
    private locks = new Map<string, Promise<void>>();

    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        // queue new waiter after the current tail
        const prev = this.locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((r) => (release = r));
        this.locks.set(
            key,
            prev.then(() => next)
        );

        try {
            await prev;
            return await fn();
        } finally {
            release();
            // cleanup tail when this chain finishes
            if (this.locks.get(key) === next) this.locks.delete(key);
        }
    }
}

export class DynalistService {
    constructor(private readonly client: DynalistClient) {}

    private readonly mutex = new PerDocMutex();

    /** List all Dynalist documents (potential shopping lists). */
    async listLists(): Promise<ListInfo[]> {
        const res = await this.client.fileList();
        return (
            (res.files || [])
                // .filter((f) => f.type === 'document')
                .map((f) => ({ id: f.id, title: f.title, type: f.type }))
        );
    }

    async createList(name: string, parentId: string): Promise<{ id: string }> {
        return this.mutex.run(parentId, async () => {
            const title = (name ?? '').trim();
            if (!title) throw new Error('List name is empty');
            if (title.length > 200) throw new Error('List name is too long');

            // Compute safe index: append to end of folder (less chance of conflicts)
            const files = await this.client.fileList();
            // Dynalist keeps a single flat list; creating with parent_id:"root" is valid.
            // We'll just pick a large index = current number of files.
            const index = files.files?.length ?? 0;

            const doCreate = async () => {
                const resp = await this.client.fileEdit([
                    {
                        action: 'create',
                        type: 'document',
                        parent_id: parentId || 'root',
                        index,
                        title,
                    },
                ]);
                const createdId = resp.created?.[0];
                if (!createdId) {
                    // Bubble up real Dynalist error text for debugging
                    throw new Error(resp._msg || 'create failed');
                }
                return { id: createdId };
            };

            // Small retry loop for transient lock/429
            let lastErr: unknown;
            for (let i = 0; i < 3; i++) {
                try {
                    return await doCreate();
                } catch (e: any) {
                    const msg = String(e?.message || '');
                    // common transient cases from Dynalist: lock fail, too many requests
                    if (!/lock|TooManyRequests/i.test(msg)) throw e;
                    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
                    lastErr = e;
                }
            }
            throw lastErr instanceof Error
                ? lastErr
                : new Error(String(lastErr));
        });
    }

    /** Get items (top-level nodes) of a shopping list document. */
    async getItems(listId: string): Promise<ShoppingItem[]> {
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);
        const root = nodes.get('root');
        if (!root) return [];

        const ids = (root.children || []) as string[];
        const items: ShoppingItem[] = [];
        for (const id of ids) {
            const n = nodes.get(id);
            if (!n) continue;
            items.push({
                id: n.id,
                content: n.content || '',
                note: n.note ?? undefined,
                checked: !!n.checked,
                _node: n,
            });
        }
        return items;
    }


    /**
     * Batch add multiple items in one round-trip.
     * Good when the LLM decided to add 3+ items "simultaneously".
     */
    async addItems(
        listId: string,
        texts: Array<{ text: string; opts?: AddItemOptions }>
    ): Promise<{ ids: string[] }> {
        if (texts.length === 0) return { ids: [] };

        return this.mutex.run(listId, async () => {
            // single read, compute contiguous indices
            const doc = await this.client.docRead(listId);
            const start = getRootChildrenCount(doc);

            const changes: DocEditChange[] = [];
            let offset = 0;

            for (const { text, opts } of texts) {
                const position = opts?.position ?? 'bottom';
                const index = position === 'top' ? 0 + offset : start + offset;
                offset++;

                const change: any = {
                    action: 'insert',
                    parent_id: 'root',
                    index,
                    content: text,
                };
                if (opts?.note !== undefined) change.note = opts.note;
                if (opts?.checked !== undefined) change.checked = opts.checked;
                if (opts?.checkbox !== undefined) change.checkbox = opts.checkbox;
                if (opts?.heading !== undefined) change.heading = opts.heading;
                if (opts?.color !== undefined) change.color = opts.color;
                
                changes.push(change);
            }

            const resp = await this.client.docEdit(listId, changes);
            const ids = resp.new_node_ids ?? [];
            if (ids.length !== texts.length) {
                throw new Error(
                    `Inserted ${ids.length} of ${texts.length} items`
                );
            }
            return { ids };
        });
    }



    /** Rename a list (document). */
    async renameList(listId: string, newName: string): Promise<void> {
        await this.mutex.run(listId, async () => {
            await this.client.fileEdit([
                {
                    action: 'edit',
                    type: 'document',
                    file_id: listId,
                    title: newName,
                },
            ]);
        });
    }

    /**
     * Clear all checked items from a list (bulk delete).
     * Returns number of deleted nodes.
     */
    async clearList(listId: string): Promise<number> {
        return this.mutex.run(listId, async () => {
            const items = await this.getItems(listId);
            const toDelete = items.filter((i) => i.checked).map((i) => i.id);
            if (toDelete.length === 0) return 0;

            await this.client.docEdit(
                listId,
                toDelete.map<DocEditChange>((id) => ({
                    action: 'delete',
                    node_id: id,
                }))
            );
            return toDelete.length;
        });
    }


    /**
     * Move item to a new position.
     * - position: "top" | "bottom"
     * - or relative: { before?: targetId, after?: targetId }
     */
    async moveItem(
        listId: string,
        nodeId: string,
        position: 'top' | 'bottom' | { before?: string; after?: string }
    ): Promise<void> {
        await this.mutex.run(listId, async () => {
            // Read once to compute index
            const doc = await this.client.docRead(listId);
            const root = doc.nodes.find((n) => n.id === 'root');
            const ids: string[] = (root?.children as string[]) ?? [];

            let index = 0;
            if (position === 'top') {
                index = 0;
            } else if (position === 'bottom') {
                index = ids.length;
            } else if (position.before) {
                const i = ids.indexOf(position.before);
                if (i < 0) throw new Error("Target 'before' node not found");
                index = i;
            } else if (position.after) {
                const i = ids.indexOf(position.after);
                if (i < 0) throw new Error("Target 'after' node not found");
                index = i + 1;
            }

            const change: DocEditChange = {
                action: 'move',
                node_id: nodeId,
                parent_id: 'root',
                index,
            };
            await this.client.docEdit(listId, [change]);
        });
    }

    /**
     * Batch delete multiple items by their node IDs.
     */
    async deleteItems(listId: string, nodeIds: string[]): Promise<number> {
        return this.mutex.run(listId, async () => {
            if (nodeIds.length === 0) return 0;

            const changes: DocEditChange[] = nodeIds.map(nodeId => ({
                action: 'delete',
                node_id: nodeId
            }));

            await this.client.docEdit(listId, changes);
            return nodeIds.length;
        });
    }

    /**
     * Batch check/uncheck multiple items by their node IDs.
     */
    async checkItems(listId: string, nodeIds: string[], checked: boolean = true): Promise<number> {
        return this.mutex.run(listId, async () => {
            if (nodeIds.length === 0) return 0;

            const changes: DocEditChange[] = nodeIds.map(nodeId => ({
                action: 'edit',
                node_id: nodeId,
                checked
            }));

            await this.client.docEdit(listId, changes);
            return nodeIds.length;
        });
    }

    /**
     * Batch edit multiple items with different changes.
     */
    async editItems(
        listId: string,
        edits: Array<{
            nodeId: string;
            changes: {
                content?: string;
                note?: string;
                checked?: boolean;
                checkbox?: boolean;
                heading?: 0 | 1 | 2 | 3;
                color?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
            };
        }>
    ): Promise<number> {
        return this.mutex.run(listId, async () => {
            if (edits.length === 0) return 0;

            const changes: DocEditChange[] = edits.map(edit => ({
                action: 'edit',
                node_id: edit.nodeId,
                ...edit.changes
            }));

            await this.client.docEdit(listId, changes);
            return edits.length;
        });
    }

}

/* ----------------- helpers ----------------- */

function indexById(nodes: DocNode[]): Map<string, DocNode> {
    const map = new Map<string, DocNode>();
    for (const n of nodes) map.set(n.id, n);
    return map;
}

function getRootChildrenCount(doc: DocReadResponse): number {
    const root = doc.nodes.find((n) => n.id === 'root');
    if (!root) return 0;
    const ids = (root.children || []) as string[];
    return ids.length;
}