import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MemoryState } from "@resident/shared";
import { createMemoryState } from "./memory-state";

export interface MemoryStoreData {
  memory: MemoryState;
}

export class FileBackedMemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryStoreData> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as MemoryStoreData;
    } catch {
      return {
        memory: createMemoryState()
      };
    }
  }

  async save(data: MemoryStoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
