# E2E tests

## Prerequisites

Before running E2E tests, ensure you have these folders in your Dynalist account:

1. **`__tests__`** - Used as the root container for all test data to avoid cluttering your main lists
2. **`__trash__`** - Used for test cleanup since the Dynalist API doesn't support file deletion

## API Limitation: File Deletion

**Important**: The Dynalist API does not support deleting files/documents. The available file operations are only:
- `create` - Create a new document/folder
- `edit` - Change a document/folder's title  
- `move` - Move a document/folder to another location

## Test Workaround for "Deletion"

Since true deletion isn't supported, the E2E tests use this workaround:
1. Rename the file to include a deletion timestamp: `[deleted-2025-01-15T14-30-25-123Z]`
2. Move the file to the `__trash__` folder
3. Verify the file is no longer in its original location

This approach:
- ✅ Simulates deletion for testing purposes
- ✅ Keeps test data organized and out of main workspace
- ✅ Allows manual cleanup of old test files if needed
- ❌ Does not actually delete files (API limitation)

## Basic Functionality

 - list the lists
 - find the `__tests__` folder (must pre-exist)
 - find the `__trash__` folder (must pre-exist)
 - create a list "e2e-test-list-1" under the `__tests__` folder
 - get the list "e2e-test-list-1"
 - make sure the list is empty
 - add an item to the list
 - get the list "e2e-test-list-1"
 - make sure the list has one item
 - list the lists
 - make sure the list "e2e-test-list-1" is listed
 - move the list "e2e-test-list-1" to trash with timestamp (delete workaround)
 - verify the list is no longer in `__tests__` folder
 - verify the list now exists in `__trash__` folder with deletion timestamp
 - ok

## Item Operations

 - create a test list "e2e-item-ops-test" under the `__tests__` folder
 - verify the list starts empty
 - **addItems**: add multiple items in batch with various options (checked/unchecked, notes)
   - "Buy milk" (unchecked)
   - "Buy bread" (unchecked) 
   - "Buy eggs" (checked)
   - "Buy butter" (with note: "Unsalted preferred")
   - "Call dentist" (unchecked)
 - verify all 5 items were added with correct properties
 - **checkItems**: check multiple items in batch (milk, bread, dentist)
 - verify the 3 items are now checked
 - **editItems**: edit items in batch (change butter to "Buy organic butter" with new note and check it)
 - verify item was edited correctly
 - **clearList**: remove all checked items from the list
 - verify only unchecked items remain (should be fewer than 5 items)
 - add more test items: "Item to delete 1", "Item to delete 2", "Item to keep"  
 - **deleteItems**: delete specific items in batch (the 2 "delete" items)
 - verify the 2 items were deleted but "Item to keep" remains
 - add items for move test: "First item", "Second item", "Third item"
 - **moveItem (top)**: move "Second item" to top position
 - verify "Second item" is now at position 0
 - **moveItem (bottom)**: move "First item" to bottom position  
 - verify "First item" is now at the last position
 - **moveItem (before)**: move "Third item" before "First item"
 - verify "Third item" appears before "First item" in the list
 - **moveItem (after)**: move "Second item" after "First item" 
 - verify "Second item" appears immediately after "First item"
 - **moveItem (error cases)**: test error handling for non-existent target items
 - verify proper error messages for invalid "before" and "after" targets
 - clean up: move test list "e2e-item-ops-test" to trash
 - ok
