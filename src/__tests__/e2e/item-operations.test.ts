import { beforeAll, describe, it, expect, afterAll } from '@jest/globals';
import { config } from 'dotenv';
import { DynalistClient } from '../../dynalist/DynalistClient';
import { DynalistService } from '../../dynalist/DynalistService';

// Load test environment variables
config({ path: '.env.test' });

describe('E2E Item Operations', () => {
    let service: DynalistService;
    let client: DynalistClient;
    let testListId: string;
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

    beforeAll(async () => {
        const token = process.env.TOKEN;
        if (!token) {
            throw new Error('TOKEN not found in .env.test file');
        }

        client = new DynalistClient({ token });
        service = new DynalistService(client);

        // Find required folders
        const lists = await service.listLists();
        
        const testsFolder = lists.find((item) => item.type === 'folder' && item.title === '__tests__');
        if (!testsFolder) {
            throw new Error('__tests__ folder not found. Please create a folder named "__tests__" in your Dynalist account for test data.');
        }
        rootFolderId = testsFolder.id;

        const trashFolder = lists.find((item) => item.type === 'folder' && item.title === '__trash__');
        if (!trashFolder) {
            throw new Error('__trash__ folder not found. Please create a folder named "__trash__" in your Dynalist account for test cleanup.');
        }
        trashFolderId = trashFolder.id;

        // Create test list for item operations
        const result = await service.createList('e2e-item-ops-test', rootFolderId);
        testListId = result.id;
    });

    afterAll(async () => {
        // Clean up: move test list to trash
        if (testListId) {
            await moveListToTrash(testListId, 'e2e-item-ops-test');
        }
    });

    it('should start with an empty list', async () => {
        const items = await service.getItems(testListId);
        expect(items.length).toBe(0);
    });

    it('should add multiple items in batch', async () => {
        const result = await service.addItems(testListId, [
            { text: 'Buy milk', opts: { checked: false } },
            { text: 'Buy bread', opts: { checked: false } },
            { text: 'Buy eggs', opts: { checked: true } }, // Already completed
            { text: 'Buy butter', opts: { note: 'Unsalted preferred' } },
            { text: 'Call dentist', opts: { checked: false } },
        ]);

        expect(result.ids.length).toBe(5);
        result.ids.forEach(id => expect(typeof id).toBe('string'));
    });

    it('should verify all items were added correctly', async () => {
        const items = await service.getItems(testListId);
        expect(items.length).toBe(5);

        // Check specific items
        const milkItem = items.find(item => item.content === 'Buy milk');
        expect(milkItem).toBeDefined();
        expect(milkItem?.checked).toBe(false);

        const eggsItem = items.find(item => item.content === 'Buy eggs');
        expect(eggsItem).toBeDefined();
        expect(eggsItem?.checked).toBe(true);

        const butterItem = items.find(item => item.content === 'Buy butter');
        expect(butterItem).toBeDefined();
        expect(butterItem?.note).toBe('Unsalted preferred');
    });

    it('should check multiple items in batch', async () => {
        const items = await service.getItems(testListId);
        const milkItem = items.find(item => item.content === 'Buy milk');
        const breadItem = items.find(item => item.content === 'Buy bread');
        const dentistItem = items.find(item => item.content === 'Call dentist');

        expect(milkItem).toBeDefined();
        expect(breadItem).toBeDefined();
        expect(dentistItem).toBeDefined();

        // Check multiple items
        const checkedCount = await service.checkItems(
            testListId, 
            [milkItem!.id, breadItem!.id, dentistItem!.id], 
            true
        );
        expect(checkedCount).toBe(3);
    });

    it('should verify items were checked', async () => {
        const items = await service.getItems(testListId);
        
        const milkItem = items.find(item => item.content === 'Buy milk');
        const breadItem = items.find(item => item.content === 'Buy bread');
        const dentistItem = items.find(item => item.content === 'Call dentist');

        expect(milkItem?.checked).toBe(true);
        expect(breadItem?.checked).toBe(true);
        expect(dentistItem?.checked).toBe(true);
    });

    it('should edit multiple items in batch', async () => {
        const items = await service.getItems(testListId);
        const butterItem = items.find(item => item.content === 'Buy butter');

        expect(butterItem).toBeDefined();

        // Edit the butter item and add a new item via batch edit
        const editedCount = await service.editItems(testListId, [
            {
                nodeId: butterItem!.id,
                changes: {
                    content: 'Buy organic butter',
                    note: 'From the local farm store',
                    checked: true,
                }
            }
        ]);
        expect(editedCount).toBe(1);
    });

    it('should verify item was edited', async () => {
        const items = await service.getItems(testListId);
        const butterItem = items.find(item => item.content === 'Buy organic butter');

        expect(butterItem).toBeDefined();
        expect(butterItem?.note).toBe('From the local farm store');
        expect(butterItem?.checked).toBe(true);
    });

    it('should clear checked items from list', async () => {
        // Before clearing, verify we have checked items
        const itemsBefore = await service.getItems(testListId);
        const checkedItemsBefore = itemsBefore.filter(item => item.checked);
        expect(checkedItemsBefore.length).toBeGreaterThan(0);

        // Clear checked items
        const deletedCount = await service.clearList(testListId);
        expect(deletedCount).toBe(checkedItemsBefore.length);
    });

    it('should verify only unchecked items remain after clear', async () => {
        const items = await service.getItems(testListId);
        
        // All remaining items should be unchecked
        items.forEach(item => {
            expect(item.checked).toBe(false);
        });

        // Should have fewer items than before
        expect(items.length).toBeLessThan(5);
    });

    it('should add more items for delete operations test', async () => {
        const result = await service.addItems(testListId, [
            { text: 'Item to delete 1' },
            { text: 'Item to delete 2' },
            { text: 'Item to keep' },
        ]);

        expect(result.ids.length).toBe(3);
    });

    it('should delete specific items in batch', async () => {
        const items = await service.getItems(testListId);
        const itemsToDelete = items.filter(item => item.content.includes('Item to delete'));
        
        expect(itemsToDelete.length).toBe(2);

        const deletedCount = await service.deleteItems(
            testListId,
            itemsToDelete.map(item => item.id)
        );
        expect(deletedCount).toBe(2);
    });

    it('should verify specific items were deleted', async () => {
        const items = await service.getItems(testListId);
        
        // Should not find deleted items
        const deletedItems = items.filter(item => item.content.includes('Item to delete'));
        expect(deletedItems.length).toBe(0);

        // Should still find the kept item
        const keptItem = items.find(item => item.content === 'Item to keep');
        expect(keptItem).toBeDefined();
    });

    it('should test moveItem functionality - move to top', async () => {
        // Add a few more items to test moving
        await service.addItems(testListId, [
            { text: 'First item' },
            { text: 'Second item' },
            { text: 'Third item' },
        ]);

        const itemsBefore = await service.getItems(testListId);
        const secondItem = itemsBefore.find(item => item.content === 'Second item');
        expect(secondItem).toBeDefined();

        // Move second item to top
        await service.moveItem(testListId, secondItem!.id, 'top');

        const itemsAfter = await service.getItems(testListId);
        expect(itemsAfter[0]?.content).toBe('Second item');
    });

    it('should test moveItem functionality - move to bottom', async () => {
        const itemsBefore = await service.getItems(testListId);
        const firstItem = itemsBefore.find(item => item.content === 'First item');
        expect(firstItem).toBeDefined();

        // Move first item to bottom
        await service.moveItem(testListId, firstItem!.id, 'bottom');

        const itemsAfter = await service.getItems(testListId);
        const lastIndex = itemsAfter.length - 1;
        expect(itemsAfter[lastIndex]?.content).toBe('First item');
    });

    it('should test moveItem functionality - move before specific item', async () => {
        // First, let's get current state and pick two items
        const itemsBefore = await service.getItems(testListId);
        expect(itemsBefore.length).toBeGreaterThanOrEqual(2);
        
        // Use the last item and move it before the first item
        const lastItem = itemsBefore[itemsBefore.length - 1];
        const firstItem = itemsBefore[0];
        
        expect(lastItem).toBeDefined();
        expect(firstItem).toBeDefined();
        
        // Move last item before first item
        await service.moveItem(testListId, lastItem!.id, { before: firstItem!.id });

        const itemsAfter = await service.getItems(testListId);
        expect(itemsAfter[0]?.id).toBe(lastItem!.id); // Last item should now be first
    });

    it('should test moveItem functionality - move after specific item', async () => {
        const itemsBefore = await service.getItems(testListId);
        expect(itemsBefore.length).toBeGreaterThanOrEqual(3);
        
        // Move the first item after the second item
        const firstItem = itemsBefore[0];
        const secondItem = itemsBefore[1];
        
        expect(firstItem).toBeDefined();
        expect(secondItem).toBeDefined();
        
        // Move first item after second item
        await service.moveItem(testListId, firstItem!.id, { after: secondItem!.id });

        const itemsAfter = await service.getItems(testListId);
        const firstItemNewIndex = itemsAfter.findIndex(item => item.id === firstItem!.id);
        const secondItemNewIndex = itemsAfter.findIndex(item => item.id === secondItem!.id);
        
        // After moving first item after second item, first should be after second
        expect(firstItemNewIndex).toBeGreaterThan(secondItemNewIndex);
    });

    it('should handle moveItem error cases', async () => {
        const items = await service.getItems(testListId);
        const firstItem = items[0];
        expect(firstItem).toBeDefined();

        // Test moving before non-existent item
        await expect(
            service.moveItem(testListId, firstItem!.id, { before: 'non-existent-id' })
        ).rejects.toThrow("Target 'before' node not found");

        // Test moving after non-existent item  
        await expect(
            service.moveItem(testListId, firstItem!.id, { after: 'non-existent-id' })
        ).rejects.toThrow("Target 'after' node not found");
    });
});