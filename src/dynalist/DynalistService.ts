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

export type ListItem = {
    id: string;
    content: string;
    note: string | undefined;
    checked: boolean;
    children?: string[]; // child node ids for hierarchical structure
    _node: DocNode | undefined;
};

export type ListItemWithTree = Omit<ListItem, 'children'> & {
    children: ListItemWithTree[];
    depth: number;
};

export type TreeNode = {
    content: string;
    note?: string;
    checked?: boolean;
    checkbox?: boolean;
    heading?: 0 | 1 | 2 | 3;
    color?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    children?: TreeNode[];
};

export type AddItemOptions = {
    note?: string;
    checked?: boolean;
    checkbox?: boolean;
    heading?: 0 | 1 | 2 | 3;
    color?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    position?: 'top' | 'bottom'; // default: bottom
};

export type MoveTarget = {
    parent?: string;    // change parent (if omitted, stays in current parent)
    position?: 'top' | 'bottom' | number;
    before?: string;
    after?: string;
};

export type RestructureOperation = {
    nodeId: string;
    newParent?: string; // if omitted, stays at root level
    newIndex: number;   // position within parent
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

    /**
     * Get all items in hierarchical tree structure with depth information.
     * Returns items organized as a tree with children populated.
     */
    async getItemsWithTree(listId: string): Promise<ListItemWithTree[]> {
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);
        const root = nodes.get('root');
        if (!root) return [];

        const buildTree = (nodeIds: string[], depth = 0): ListItemWithTree[] => {
            const items: ListItemWithTree[] = [];

            for (const id of nodeIds) {
                const n = nodes.get(id);
                if (!n) continue;

                const children = n.children ? buildTree(n.children as string[], depth + 1) : [];

                items.push({
                    id: n.id,
                    content: n.content || '',
                    note: n.note ?? undefined,
                    checked: !!n.checked,
                    children: children,
                    _node: n,
                    depth,
                });
            }

            return items;
        };

        return buildTree(root.children as string[] || []);
    }

    /**
     * Get direct children of a specific node.
     * Returns flat list of immediate children only (not nested).
     */
    async getItemChildren(listId: string, parentNodeId: string): Promise<ListItem[]> {
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);
        const parent = nodes.get(parentNodeId);

        if (!parent) {
            throw new Error(`Parent node ${parentNodeId} not found`);
        }

        const childIds = (parent.children as string[]) ?? [];
        const children: ListItem[] = [];

        for (const id of childIds) {
            const n = nodes.get(id);
            if (!n) continue;

            const item: ListItem = {
                id: n.id,
                content: n.content || '',
                note: n.note ?? undefined,
                checked: !!n.checked,
                _node: n,
            };
            if (n.children) {
                item.children = n.children as string[];
            }
            children.push(item);
        }

        return children;
    }

    /** Get items (top-level nodes) of a shopping list document. */
    async getItems(listId: string): Promise<ListItem[]> {
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);
        const root = nodes.get('root');
        if (!root) return [];

        const ids = (root.children || []) as string[];
        const items: ListItem[] = [];
        for (const id of ids) {
            const n = nodes.get(id);
            if (!n) continue;
            const item: ListItem = {
                id: n.id,
                content: n.content || '',
                note: n.note ?? undefined,
                checked: !!n.checked,
                _node: n,
            };
            if (n.children) {
                item.children = n.children as string[];
            }
            items.push(item);
        }
        return items;
    }


    /**
     * Batch add multiple items in one round-trip.
     * Good when the LLM decided to add 3+ items "simultaneously".
     */
    /**
     * Internal version of addItems without mutex - for use within mutex-protected methods
     */
    private async addItemsInternal(
        listId: string,
        texts: Array<{ text: string; opts?: AddItemOptions }>
    ): Promise<{ ids: string[] }> {
        if (texts.length === 0) return { ids: [] };

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
    }

    async addItems(
        listId: string,
        texts: Array<{ text: string; opts?: AddItemOptions }>
    ): Promise<{ ids: string[] }> {
        if (texts.length === 0) return { ids: [] };

        return this.mutex.run(listId, async () => {
            return this.addItemsInternal(listId, texts);
        });
    }

    /**
     * Add multiple items as children of a specific parent node.
     * Similar to addItems but for hierarchical insertion.
     */
    async addSubItems(
        listId: string,
        parentNodeId: string,
        texts: Array<{ text: string; opts?: AddItemOptions }>
    ): Promise<{ ids: string[] }> {
        if (texts.length === 0) return { ids: [] };

        return this.mutex.run(listId, async () => {
            // Read document to get parent's current children count
            const doc = await this.client.docRead(listId);
            const nodes = indexById(doc.nodes);
            const parent = nodes.get(parentNodeId);

            if (!parent) {
                throw new Error(`Parent node ${parentNodeId} not found`);
            }

            const parentChildren = (parent.children as string[]) ?? [];
            const start = parentChildren.length;

            const changes: DocEditChange[] = [];
            let offset = 0;

            for (const { text, opts } of texts) {
                const position = opts?.position ?? 'bottom';
                const index = position === 'top' ? 0 + offset : start + offset;
                offset++;

                const change: any = {
                    action: 'insert',
                    parent_id: parentNodeId,
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
                    `Inserted ${ids.length} of ${texts.length} sub-items`
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
     * Move item to a new position with optional parent change.
     * Supports flat moves and hierarchical restructuring.
     */
    async moveItem(
        listId: string,
        nodeId: string,
        target: MoveTarget
    ): Promise<void> {
        await this.mutex.run(listId, async () => {
            // Read document to get current structure
            const doc = await this.client.docRead(listId);
            const nodes = indexById(doc.nodes);

            // Find current node to determine current parent if needed
            const currentNode = nodes.get(nodeId);
            if (!currentNode) {
                throw new Error(`Node ${nodeId} not found`);
            }

            // Determine target parent
            let targetParentId = target.parent;
            if (targetParentId === undefined) {
                // Find current parent by searching through all nodes
                targetParentId = 'root'; // default
                for (const [id, node] of nodes.entries()) {
                    if (node.children?.includes(nodeId)) {
                        targetParentId = id;
                        break;
                    }
                }
            }

            // Get target parent's children list
            const targetParent = nodes.get(targetParentId);
            if (!targetParent) {
                throw new Error(`Target parent ${targetParentId} not found`);
            }
            const siblings: string[] = (targetParent.children as string[]) ?? [];

            // Calculate target index
            let index = 0;
            if (typeof target.position === 'number') {
                index = Math.max(0, Math.min(target.position, siblings.length));
            } else if (target.position === 'top') {
                index = 0;
            } else if (target.position === 'bottom') {
                index = siblings.length;
            } else if (target.before) {
                const i = siblings.indexOf(target.before);
                if (i < 0) throw new Error("Target 'before' node not found");
                index = i;
            } else if (target.after) {
                const i = siblings.indexOf(target.after);
                if (i < 0) throw new Error("Target 'after' node not found");
                index = i + 1;
            } else {
                // Default to bottom if no position specified
                index = siblings.length;
            }

            const change: DocEditChange = {
                action: 'move',
                node_id: nodeId,
                parent_id: targetParentId,
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

    /**
     * Batch restructure multiple items with move operations only.
     * Efficient way to reorganize tree structure in a single API call.
     */
    /**
     * Internal version of restructureItems without mutex - for use within mutex-protected methods
     */
    private async restructureItemsInternal(
        listId: string,
        operations: RestructureOperation[]
    ): Promise<number> {
        if (operations.length === 0) return 0;

        // Read document once to validate all nodes exist
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);

        // Validate all nodes exist
        for (const op of operations) {
            if (!nodes.has(op.nodeId)) {
                throw new Error(`Node ${op.nodeId} not found`);
            }
            if (op.newParent && !nodes.has(op.newParent)) {
                throw new Error(`Parent node ${op.newParent} not found`);
            }
        }

        // Convert to DocEditChange operations
        const changes: DocEditChange[] = operations.map(op => ({
            action: 'move',
            node_id: op.nodeId,
            parent_id: op.newParent ?? 'root',
            index: op.newIndex,
        }));

        await this.client.docEdit(listId, changes);
        return operations.length;
    }

    async restructureItems(
        listId: string,
        operations: RestructureOperation[]
    ): Promise<number> {
        return this.mutex.run(listId, async () => {
            return this.restructureItemsInternal(listId, operations);
        });
    }

    /**
     * Create an entire hierarchical tree structure efficiently with 2 batch requests:
     * 1. Create all nodes flat at root level
     * 2. Restructure to correct parent-child relationships
     */
    async createListHierarchically(
        listId: string,
        tree: TreeNode[]
    ): Promise<{ rootNodes: string[] }> {
        return this.mutex.run(listId, async () => {
            if (tree.length === 0) return { rootNodes: [] };

            // Phase 1: Flatten tree and collect all nodes
            const flatNodes: Array<{ node: TreeNode; depth: number; parentIndex?: number }> = [];
            const nodeIndexMap = new Map<TreeNode, number>(); // maps node to its index in flatNodes

            const flattenTree = (nodes: TreeNode[], depth: number, parentIndex?: number) => {
                for (const node of nodes) {
                    const currentIndex = flatNodes.length;
                    nodeIndexMap.set(node, currentIndex);
                    if (parentIndex !== undefined) {
                        flatNodes.push({ node, depth, parentIndex });
                    } else {
                        flatNodes.push({ node, depth });
                    }

                    if (node.children && node.children.length > 0) {
                        flattenTree(node.children, depth + 1, currentIndex);
                    }
                }
            };

            flattenTree(tree, 0);

            // Phase 2: Create all nodes flat at root level
            const createRequests = flatNodes.map(({ node }) => ({
                text: node.content,
                opts: {
                    note: node.note,
                    checked: node.checked,
                    checkbox: node.checkbox,
                    heading: node.heading,
                    color: node.color,
                } as AddItemOptions
            }));

            const { ids: createdIds } = await this.addItemsInternal(listId, createRequests);

            if (createdIds.length !== flatNodes.length) {
                throw new Error(`Created ${createdIds.length} of ${flatNodes.length} nodes`);
            }

            // Phase 3: Build restructure operations for non-root nodes
            const restructureOps: RestructureOperation[] = [];

            for (let i = 0; i < flatNodes.length; i++) {
                const flatNode = flatNodes[i];
                if (!flatNode) continue;

                const { parentIndex } = flatNode;
                if (parentIndex !== undefined) {
                    // This node needs to be moved under its parent
                    const parentId = createdIds[parentIndex];
                    if (!parentId) {
                        throw new Error(`Parent ID not found for index ${parentIndex}`);
                    }

                    // Calculate position within parent's children
                    // Count how many siblings come before this node
                    let indexWithinParent = 0;
                    for (let j = 0; j < i; j++) {
                        const sibling = flatNodes[j];
                        if (sibling && sibling.parentIndex === parentIndex) {
                            indexWithinParent++;
                        }
                    }

                    restructureOps.push({
                        nodeId: createdIds[i]!,
                        newParent: parentId,
                        newIndex: indexWithinParent,
                    });
                }
            }

            // Phase 4: Execute restructure operations if any exist
            if (restructureOps.length > 0) {
                await this.restructureItemsInternal(listId, restructureOps);
            }

            // Return root node IDs (nodes with no parent)
            const rootNodeIds: string[] = [];
            for (let i = 0; i < flatNodes.length; i++) {
                const flatNode = flatNodes[i];
                if (flatNode && flatNode.parentIndex === undefined) {
                    const rootNodeId = createdIds[i];
                    if (rootNodeId) {
                        rootNodeIds.push(rootNodeId);
                    }
                }
            }

            return { rootNodes: rootNodeIds };
        });
    }

    /**
     * Get all ancestor nodes (parent chain) of a specific node up to root.
     * Returns path from root to parent (not including the node itself).
     */
    async getItemAncestors(listId: string, nodeId: string): Promise<ListItem[]> {
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);

        if (!nodes.has(nodeId)) {
            throw new Error(`Node ${nodeId} not found`);
        }

        const ancestors: ListItem[] = [];
        const findParentPath = (targetId: string): string[] => {
            for (const [parentId, parentNode] of nodes.entries()) {
                if (parentNode.children?.includes(targetId)) {
                    if (parentId === 'root') {
                        return [];
                    }
                    return [...findParentPath(parentId), parentId];
                }
            }
            return [];
        };

        const ancestorIds = findParentPath(nodeId);
        for (const id of ancestorIds) {
            const n = nodes.get(id);
            if (!n) continue;

            const item: ListItem = {
                id: n.id,
                content: n.content || '',
                note: n.note ?? undefined,
                checked: !!n.checked,
                _node: n,
            };
            if (n.children) {
                item.children = n.children as string[];
            }
            ancestors.push(item);
        }

        return ancestors;
    }

    /**
     * Get all descendant nodes of a specific node recursively.
     * Returns flat list of all nested children.
     */
    async getItemDescendants(listId: string, nodeId: string): Promise<ListItem[]> {
        const doc = await this.client.docRead(listId);
        const nodes = indexById(doc.nodes);
        const parent = nodes.get(nodeId);

        if (!parent) {
            throw new Error(`Node ${nodeId} not found`);
        }

        const descendants: ListItem[] = [];
        const collectDescendants = (nodeIds: string[]) => {
            for (const id of nodeIds) {
                const n = nodes.get(id);
                if (!n) continue;

                const item: ListItem = {
                    id: n.id,
                    content: n.content || '',
                    note: n.note ?? undefined,
                    checked: !!n.checked,
                    _node: n,
                };
                if (n.children) {
                    item.children = n.children as string[];
                    collectDescendants(n.children as string[]);
                }
                descendants.push(item);
            }
        };

        if (parent.children) {
            collectDescendants(parent.children as string[]);
        }

        return descendants;
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