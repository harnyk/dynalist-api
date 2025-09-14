import { beforeAll, describe, it, expect, afterAll } from '@jest/globals';
import { config } from 'dotenv';
import { DynalistClient } from '../../dynalist/DynalistClient';
import { DynalistService, TreeNode } from '../../dynalist/DynalistService';

// Load test environment variables
config({ path: '.env.test' });

describe('E2E Tree Operations', () => {
    let service: DynalistService;
    let client: DynalistClient;
    let testListId: string;
    let rootFolderId: string;
    let trashFolderId: string;

    // Test helper: Move list to __trash__ folder with timestamp
    const moveListToTrash = async (
        listId: string,
        originalTitle: string
    ): Promise<void> => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashedTitle = `${originalTitle} [deleted-${timestamp}]`;

        await client.fileEdit([
            {
                action: 'edit',
                type: 'document',
                file_id: listId,
                title: trashedTitle,
            },
            {
                action: 'move',
                type: 'document',
                file_id: listId,
                parent_id: trashFolderId,
                index: 0,
            },
        ]);
    };

    afterEach(async () => {
        // anti DDOS
        return new Promise((resolve) => setTimeout(resolve, 1000));
    });

    beforeAll(async () => {
        const token = process.env.TOKEN;
        if (!token) {
            throw new Error('TOKEN not found in .env.test file');
        }

        client = new DynalistClient({ token });
        service = new DynalistService(client);

        // Find required folders
        const lists = await service.listLists();

        const testsFolder = lists.find(
            (item) => item.type === 'folder' && item.title === '__tests__'
        );
        if (!testsFolder) {
            throw new Error(
                '__tests__ folder not found. Please create a folder named "__tests__" in your Dynalist account for test data.'
            );
        }
        rootFolderId = testsFolder.id;

        const trashFolder = lists.find(
            (item) => item.type === 'folder' && item.title === '__trash__'
        );
        if (!trashFolder) {
            throw new Error(
                '__trash__ folder not found. Please create a folder named "__trash__" in your Dynalist account for test cleanup.'
            );
        }
        trashFolderId = trashFolder.id;

        // Create test list for tree operations
        const result = await service.createList(
            'e2e-tree-ops-test',
            rootFolderId
        );
        testListId = result.id;
    });

    afterAll(async () => {
        // Clean up: move test list to trash
        if (testListId) {
            await moveListToTrash(testListId, 'e2e-tree-ops-test');
        }
    });

    it('should start with an empty list', async () => {
        const items = await service.getItems(testListId);
        expect(items.length).toBe(0);
    });

    it('should create hierarchical structure with createListHierarchically', async () => {
        const treeStructure: TreeNode[] = [
            {
                content: 'Groceries',
                children: [
                    {
                        content: 'Fruits',
                        children: [
                            { content: 'Apples' },
                            { content: 'Bananas' },
                        ],
                    },
                    {
                        content: 'Vegetables',
                        children: [
                            { content: 'Carrots' },
                            { content: 'Broccoli' },
                        ],
                    },
                ],
            },
            {
                content: 'Tasks',
                children: [
                    { content: 'Call dentist' },
                    { content: 'Pay bills' },
                ],
            },
        ];

        const result = await service.createListHierarchically(
            testListId,
            treeStructure
        );
        expect(result.rootNodes.length).toBe(2);
    });

    it('should get hierarchical tree structure', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        expect(treeItems.length).toBe(2);

        const groceries = treeItems.find(
            (item) => item.content === 'Groceries'
        );
        expect(groceries).toBeDefined();
        expect(groceries!.children.length).toBe(2);
        expect(groceries!.depth).toBe(0);

        const fruits = groceries!.children.find(
            (child) => child.content === 'Fruits'
        );
        expect(fruits).toBeDefined();
        expect(fruits!.children.length).toBe(2);
        expect(fruits!.depth).toBe(1);

        const apples = fruits!.children.find(
            (child) => child.content === 'Apples'
        );
        expect(apples).toBeDefined();
        expect(apples!.depth).toBe(2);
    });

    it('should get direct children of a node', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const groceries = treeItems.find(
            (item) => item.content === 'Groceries'
        );
        expect(groceries).toBeDefined();

        const children = await service.getItemChildren(
            testListId,
            groceries!.id
        );
        expect(children.length).toBe(2);
        expect(children.map((c) => c.content)).toContain('Fruits');
        expect(children.map((c) => c.content)).toContain('Vegetables');
    });

    it('should add sub-items to existing nodes', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const fruits = treeItems
            .find((item) => item.content === 'Groceries')!
            .children.find((child) => child.content === 'Fruits');
        expect(fruits).toBeDefined();

        const result = await service.addSubItems(testListId, fruits!.id, [
            { text: 'Oranges' },
            { text: 'Grapes', opts: { note: 'Seedless preferred' } },
        ]);

        expect(result.ids.length).toBe(2);

        // Verify items were added
        const updatedChildren = await service.getItemChildren(
            testListId,
            fruits!.id
        );
        expect(updatedChildren.length).toBe(4);
        expect(updatedChildren.map((c) => c.content)).toContain('Oranges');
        expect(updatedChildren.map((c) => c.content)).toContain('Grapes');
    });

    it('should move item to different parent (convert to sub-item)', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const tasks = treeItems.find((item) => item.content === 'Tasks');
        const callDentist = tasks!.children.find(
            (child) => child.content === 'Call dentist'
        );
        const groceries = treeItems.find(
            (item) => item.content === 'Groceries'
        );

        expect(tasks).toBeDefined();
        expect(callDentist).toBeDefined();
        expect(groceries).toBeDefined();

        // Move "Call dentist" from Tasks to Groceries
        await service.moveItem(testListId, callDentist!.id, {
            parent: groceries!.id,
            position: 'bottom',
        });

        // Verify the move
        const updatedGroceries = await service.getItemChildren(
            testListId,
            groceries!.id
        );
        expect(updatedGroceries.map((c) => c.content)).toContain(
            'Call dentist'
        );

        const updatedTasks = await service.getItemChildren(
            testListId,
            tasks!.id
        );
        expect(updatedTasks.map((c) => c.content)).not.toContain(
            'Call dentist'
        );
    });

    it('should move item back to root level (promote to main)', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const groceries = treeItems.find(
            (item) => item.content === 'Groceries'
        );
        const callDentist = (
            await service.getItemChildren(testListId, groceries!.id)
        ).find((child) => child.content === 'Call dentist');

        expect(callDentist).toBeDefined();

        // Move back to root level
        await service.moveItem(testListId, callDentist!.id, {
            parent: 'root',
            position: 'bottom',
        });

        // Verify the move
        const rootItems = await service.getItems(testListId);
        expect(rootItems.map((c) => c.content)).toContain('Call dentist');

        const updatedGroceries = await service.getItemChildren(
            testListId,
            groceries!.id
        );
        expect(updatedGroceries.map((c) => c.content)).not.toContain(
            'Call dentist'
        );
    });

    it('should restructure multiple items in batch', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const groceries = treeItems.find(
            (item) => item.content === 'Groceries'
        );
        const tasks = treeItems.find((item) => item.content === 'Tasks');
        const vegetables = groceries!.children.find(
            (child) => child.content === 'Vegetables'
        );
        const fruits = groceries!.children.find(
            (child) => child.content === 'Fruits'
        );

        expect(vegetables).toBeDefined();
        expect(fruits).toBeDefined();

        // Batch move: move Vegetables under Tasks, and move Fruits to root
        const restructured = await service.restructureItems(testListId, [
            {
                nodeId: vegetables!.id,
                newParent: tasks!.id,
                newIndex: 0,
            },
            {
                nodeId: fruits!.id,
                newIndex: 1,
            },
        ]);

        expect(restructured).toBe(2);

        // Verify the restructuring
        const updatedRoot = await service.getItems(testListId);
        expect(updatedRoot.map((c) => c.content)).toContain('Fruits');

        const updatedTasks = await service.getItemChildren(
            testListId,
            tasks!.id
        );
        expect(updatedTasks.map((c) => c.content)).toContain('Vegetables');

        const updatedGroceries = await service.getItemChildren(
            testListId,
            groceries!.id
        );
        expect(updatedGroceries.map((c) => c.content)).not.toContain(
            'Vegetables'
        );
        expect(updatedGroceries.map((c) => c.content)).not.toContain('Fruits');
    });

    it('should get item ancestors', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const tasks = treeItems.find((item) => item.content === 'Tasks');
        const vegetables = (
            await service.getItemChildren(testListId, tasks!.id)
        ).find((child) => child.content === 'Vegetables');
        const carrots = (
            await service.getItemChildren(testListId, vegetables!.id)
        ).find((child) => child.content === 'Carrots');

        expect(carrots).toBeDefined();

        const ancestors = await service.getItemAncestors(
            testListId,
            carrots!.id
        );
        expect(ancestors.length).toBe(2); // Tasks -> Vegetables
        expect(ancestors[0]?.content).toBe('Tasks');
        expect(ancestors[1]?.content).toBe('Vegetables');
    });

    it('should get item descendants', async () => {
        const treeItems = await service.getItemsWithTree(testListId);
        const tasks = treeItems.find((item) => item.content === 'Tasks');
        expect(tasks).toBeDefined();

        const descendants = await service.getItemDescendants(
            testListId,
            tasks!.id
        );
        expect(descendants.length).toBeGreaterThanOrEqual(3); // Vegetables + its children

        const descendantContents = descendants.map((d) => d.content);
        expect(descendantContents).toContain('Vegetables');
        expect(descendantContents).toContain('Carrots');
        expect(descendantContents).toContain('Broccoli');
    });

    it('should handle error cases', async () => {
        // Test with non-existent node
        await expect(
            service.getItemChildren(testListId, 'non-existent-id')
        ).rejects.toThrow('Parent node non-existent-id not found');

        await expect(
            service.moveItem(testListId, 'non-existent-id', { parent: 'root' })
        ).rejects.toThrow('Node non-existent-id not found');

        await expect(
            service.getItemAncestors(testListId, 'non-existent-id')
        ).rejects.toThrow('Node non-existent-id not found');

        await expect(
            service.getItemDescendants(testListId, 'non-existent-id')
        ).rejects.toThrow('Node non-existent-id not found');
    });
});
