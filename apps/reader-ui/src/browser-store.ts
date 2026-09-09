const WAIT_MS = 5000;
/** Bounded IndexedDB operations: rejected validation and blocked upgrades must settle the caller. */
export async function browserStore<T>(databaseName: string, storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest, decode: (value: unknown) => T): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let finished = false;
    const fail = () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error("BROWSER_STORAGE_UNAVAILABLE")); } };
    const timer = setTimeout(fail, WAIT_MS);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(databaseName, 1); } catch { fail(); return; }
    request.onupgradeneeded = () => {
      if (finished) { request.transaction?.abort(); return; }
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = fail; request.onblocked = fail;
    request.onsuccess = () => {
      const connection = request.result;
      if (finished) { connection.close(); return; }
      finished = true; clearTimeout(timer);
      connection.onversionchange = () => connection.close();
      resolve(connection);
    };
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let value: T; let decoded = false; let finished = false;
      const fail = (error?: unknown) => { if (!finished) { finished = true; clearTimeout(timer); reject(error instanceof Error ? error : new Error("BROWSER_STORAGE_UNAVAILABLE")); } };
      const timer = setTimeout(() => { fail(); try { transaction.abort(); } catch { /* Already closed. */ } }, WAIT_MS);
      transaction.oncomplete = () => { if (!finished) { if (!decoded) { fail(); return; } finished = true; clearTimeout(timer); resolve(value); } };
      transaction.onerror = () => fail(transaction.error); transaction.onabort = () => fail(transaction.error);
      try {
        const request = operation(transaction.objectStore(storeName));
        request.onerror = () => fail(request.error);
        request.onsuccess = () => { try { value = decode(request.result); decoded = true; } catch (error) { fail(error); } };
      } catch (error) { fail(error); }
    });
  } finally { db.close(); }
}
