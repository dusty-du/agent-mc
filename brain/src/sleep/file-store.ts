import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConsolidationRecord,
  CultureSignal,
  MemoryBundle,
  ValueProfile
} from "@resident/shared";
import { DEFAULT_VALUE_PROFILE } from "@resident/shared";

export interface SleepStoreData {
  bundles: MemoryBundle[];
  cultureSignals: CultureSignal[];
  consolidations: ConsolidationRecord[];
  valueProfile: ValueProfile;
  salience: Record<string, number>;
}

export class FileBackedSleepStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<SleepStoreData> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as SleepStoreData;
    } catch {
      return {
        bundles: [],
        cultureSignals: [],
        consolidations: [],
        valueProfile: DEFAULT_VALUE_PROFILE,
        salience: {}
      };
    }
  }

  async save(data: SleepStoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
