const DATABASE = 'nest-notes-collaboration-drafts';
const STORE = 'drafts';

/** A write is locally saved only after its IndexedDB transaction commits. */
export function createCollaborationDraftStore(indexedDB = globalThis.indexedDB) {
    let databasePromise = null;
    function open() {
        if (databasePromise) return databasePromise;
        databasePromise = new Promise((resolve, reject) => {
            if (!indexedDB) { reject(new Error('Local note storage is unavailable.')); return; }
            let request;
            try { request = indexedDB.open(DATABASE, 1); } catch (error) { reject(error); return; }
            request.onupgradeneeded = () => {
                const database = request.result;
                const store = database.createObjectStore(STORE, { keyPath: 'key' });
                store.createIndex('identity', 'identity', { unique: false });
            };
            request.onerror = () => reject(request.error || new Error('Local note storage could not open.'));
            request.onblocked = () => reject(new Error('Local note storage is blocked.'));
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => { database.close(); databasePromise = null; };
                resolve(database);
            };
        }).catch((error) => { databasePromise = null; throw error; });
        return databasePromise;
    }
    async function transaction(mode, operation) {
        const database = await open();
        return new Promise((resolve, reject) => {
            let result;
            let transaction;
            try {
                transaction = database.transaction(STORE, mode);
                transaction.oncomplete = () => resolve(result);
                transaction.onabort = () => reject(transaction.error || new Error('Local note save was aborted.'));
                transaction.onerror = () => reject(transaction.error || new Error('Local note save failed.'));
                const request = operation(transaction.objectStore(STORE));
                request.onsuccess = () => { result = request.result; };
            } catch (error) { reject(error); }
        });
    }
    return {
        read(userId, noteId) {
            return transaction('readonly', (store) => store.index('identity').getAll(JSON.stringify([userId, noteId])));
        },
        write(record) { return transaction('readwrite', (store) => store.put(record)); },
        remove(key) { return transaction('readwrite', (store) => store.delete(key)); },
    };
}
