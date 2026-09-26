// A slow write may still complete. Report the wait without abandoning it or
// retrying it, which could create duplicate nodes or generation requests.
export async function withSubmissionWaitNotice<T>(
  operation: () => Promise<T>,
  message: string,
  notify: (message: string) => void,
): Promise<T> {
  const timer = setTimeout(() => notify(message), 5000);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
  }
}
