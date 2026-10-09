// The real database, storage, Shopify and Google wiring for processJob
import { getGoogle, shopifyFor } from "../clients";
import { sheetSource } from "../files";
import { prismaRunStore, uploadedImages } from "../run-store";
import { getSettings } from "../shops";
import { getStorage } from "../storage";
import type { ProcessDeps } from "./process";
import type { JobQueue } from "./queue";
import { prismaJobRepo } from "./service";

export function productionDeps(opts: { queue?: JobQueue; shuttingDown?: () => boolean } = {}): ProcessDeps {
  return {
    repo: prismaJobRepo(opts.queue),
    storage: getStorage(),
    google: getGoogle(),
    loadSettings: getSettings,
    sheetSource,
    uploadedImages,
    shopifyFor,
    runStore: prismaRunStore,
    shuttingDown: opts.shuttingDown,
  };
}
