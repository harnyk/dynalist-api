import { beforeAll, describe, it, expect, afterAll } from '@jest/globals';
import { config } from 'dotenv';
import { DynalistClient } from '../../dynalist/DynalistClient';
import { DynalistService } from '../../dynalist/DynalistService';

// Load test environment variables
config({ path: '.env.test' });

describe('E2E Rename List Operations', () => {
    let service: DynalistService;
    let client: DynalistClient;
    let testListId: string;
    let rootFolderId: string;
    let trashFolderId: string;

    // Test helper: Move list to __trash__ folder with timestamp (workaround for missing delete API)
    const moveListToTrash = async (
        listId: string,
        originalTitle: string
    ): Promise<void> => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashedTitle = `${originalTitle} [deleted-${timestamp}]`;

        await client.fileEdit([
            // First rename with timestamp
            {
                action: 'edit',
                type: 'document',
                file_id: listId,
                title: trashedTitle,
            },
            // Then move to trash folder
            {
                action: 'move',
                type: 'document',
                file_id: listId,
                parent_id: trashFolderId,
                index: 0, // Put at top of trash folder
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

        // Create test list for rename operations
        const result = await service.createList(
            'e2e-rename-test-original',
            rootFolderId
        );
        testListId = result.id;
    });

    afterAll(async () => {
        // Clean up: move test list to trash
        if (testListId) {
            // Get current title first
            const lists = await service.listLists();
            const currentList = lists.find((list) => list.id === testListId);
            const currentTitle = currentList?.title || 'e2e-rename-test';
            await moveListToTrash(testListId, currentTitle);
        }
    });

    it('should start with the original name', async () => {
        const lists = await service.listLists();
        const testList = lists.find((list) => list.id === testListId);

        expect(testList).toBeDefined();
        expect(testList?.title).toBe('e2e-rename-test-original');
    });

    it('should rename list to a new name', async () => {
        const newName = 'e2e-rename-test-updated';

        await service.renameList(testListId, newName);

        // Verify the rename worked
        const lists = await service.listLists();
        const testList = lists.find((list) => list.id === testListId);

        expect(testList).toBeDefined();
        expect(testList?.title).toBe(newName);
    });

    it('should rename list to another new name', async () => {
        const anotherName = 'e2e-rename-test-final';

        await service.renameList(testListId, anotherName);

        // Verify the second rename worked
        const lists = await service.listLists();
        const testList = lists.find((list) => list.id === testListId);

        expect(testList).toBeDefined();
        expect(testList?.title).toBe(anotherName);
    });

    it('should handle renaming with special characters and spaces', async () => {
        const specialName = 'Test List with Spaces & Special-Characters_123';

        await service.renameList(testListId, specialName);

        // Verify the rename with special characters worked
        const lists = await service.listLists();
        const testList = lists.find((list) => list.id === testListId);

        expect(testList).toBeDefined();
        expect(testList?.title).toBe(specialName);
    });

    it('should handle empty string rename (edge case)', async () => {
        const emptyName = '';

        await service.renameList(testListId, emptyName);

        // Verify the empty name was set (API behavior may vary)
        const lists = await service.listLists();
        const testList = lists.find((list) => list.id === testListId);

        expect(testList).toBeDefined();
        // Accept either empty string or some default behavior from API
        expect(typeof testList?.title).toBe('string');
    });

    it('should handle very long name (edge case)', async () => {
        const longName = 'A'.repeat(300); // Very long name to test API limits

        await service.renameList(testListId, longName);

        // Verify the long name behavior (API may truncate or accept it)
        const lists = await service.listLists();
        const testList = lists.find((list) => list.id === testListId);

        expect(testList).toBeDefined();
        expect(typeof testList?.title).toBe('string');
        // The API might truncate, but we just verify it's a string response
    });
});
