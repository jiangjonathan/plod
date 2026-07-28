export function notifyListeners(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
