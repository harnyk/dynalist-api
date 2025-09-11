import { beforeAll, describe, it, expect } from '@jest/globals';
import { config } from 'dotenv';
import { DynalistClient } from '../../dynalist/DynalistClient';
import { DynalistService } from '../../dynalist/DynalistService';

// Load test environment variables
config({ path: '.env.test' });

describe('E2E Basic Functionality', () => {
    let service: DynalistService;
    let client: DynalistClient;
    let createdListId: string;
    let rootFolderId: string;
    let trashFolderId: string;

    // Test helper: Move list to __trash__ folder with timestamp (workaround for missing delete API)
    const moveListToTrash = async (listId: string, originalTitle: string): Promise<void> => {
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

    beforeAll(() => {
        const token = process.env.TOKEN;
        if (!token) {
            throw new Error('TOKEN not found in .env.test file');
        }

        client = new DynalistClient({ token });
        service = new DynalistService(client);
    });

    it('should list the lists', async () => {
        const lists = await service.listLists();
        expect(Array.isArray(lists)).toBe(true);

        // Find the __tests__ folder which is assumed to pre-exist
        const testsFolder = lists.find((item) => item.type === 'folder' && item.title === '__tests__');
        if (testsFolder) {
            rootFolderId = testsFolder.id;
        } else {
            throw new Error('__tests__ folder not found. Please create a folder named "__tests__" in your Dynalist account for test data.');
        }

        // Find or expect the __trash__ folder for cleanup (workaround for missing delete API)
        const trashFolder = lists.find((item) => item.type === 'folder' && item.title === '__trash__');
        if (trashFolder) {
            trashFolderId = trashFolder.id;
        } else {
            throw new Error('__trash__ folder not found. Please create a folder named "__trash__" in your Dynalist account for test cleanup.');
        }
    });

    it('should create a list "e2e-test-list-1"', async () => {
        const result = await service.createList(
            'e2e-test-list-1',
            rootFolderId
        );
        expect(result.id).toBeDefined();
        expect(typeof result.id).toBe('string');
        createdListId = result.id;
    });

    it('should get the list "e2e-test-list-1"', async () => {
        expect(createdListId).toBeDefined();
        const items = await service.getItems(createdListId);
        expect(Array.isArray(items)).toBe(true);
    });

    it('should make sure the list is empty', async () => {
        const items = await service.getItems(createdListId);
        expect(items.length).toBe(0);
    });

    it('should add an item to the list', async () => {
        const result = await service.addItems(createdListId, [{ text: 'Test item' }]);
        expect(result.ids).toBeDefined();
        expect(result.ids.length).toBe(1);
        expect(typeof result.ids[0]).toBe('string');
    });

    it('should get the list "e2e-test-list-1" and make sure it has one item', async () => {
        const items = await service.getItems(createdListId);
        expect(items.length).toBe(1);
        expect(items[0]?.content).toBe('Test item');
    });

    it('should list the lists and make sure "e2e-test-list-1" is listed', async () => {
        const lists = await service.listLists();
        const testList = lists.find((list) => list.title === 'e2e-test-list-1');
        expect(testList).toBeDefined();
        expect(testList?.id).toBe(createdListId);
    });

    it('should move the list "e2e-test-list-1" to trash (delete workaround)', async () => {
        // Use workaround: move to __trash__ folder with timestamp since Dynalist API doesn't support file deletion
        await moveListToTrash(createdListId, 'e2e-test-list-1');

        // Verify the list is no longer in the __tests__ folder
        const lists = await service.listLists();
        const testListInTests = lists.find((list) => 
            list.id === createdListId && 
            list.title === 'e2e-test-list-1' // Original title
        );
        expect(testListInTests).toBeUndefined();

        // Verify the list now exists in __trash__ folder with timestamp
        const trashedList = lists.find((list) => 
            list.id === createdListId && 
            list.title.includes('[deleted-')
        );
        expect(trashedList).toBeDefined();
        expect(trashedList?.title).toMatch(/e2e-test-list-1 \[deleted-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });
});
