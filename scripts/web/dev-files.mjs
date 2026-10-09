import { copyFile } from "node:fs/promises";

// Keep the previous executable until the new backend has actually started.
export async function replaceBackend({ compiled, running, previous, retainPrevious, stop, start }) {
  if (retainPrevious) await copyFile(running, previous);
  await stop();
  try {
    await copyFile(compiled, running);
    await start();
    return null;
  } catch (error) {
    await stop();
    if (!retainPrevious) throw error;
    await copyFile(previous, running);
    await start();
    return error;
  }
}
