/** Stop waiting promptly, while also observing any late rejection from the underlying work. */
export async function abortableOperation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("OPERATION_CANCELLED");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("OPERATION_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new Error("OPERATION_CANCELLED");
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
