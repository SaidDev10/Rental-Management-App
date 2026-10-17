import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const limitsInMegabytes: Record<string, number> = {
  'api-handler': 90,
  authorizer: 5,
  'pdf-worker': 220,
  'report-worker': 100,
  'notification-worker': 30,
  'stream-aggregator': 5,
};

const directorySize = async (directory: string): Promise<number> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return directorySize(entryPath);
      }

      const fileStat = await stat(entryPath);

      return fileStat.size;
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
};

for (const [artifactName, limitInMegabytes] of Object.entries(limitsInMegabytes)) {
  const artifactDirectory = path.resolve('dist', artifactName);
  const sizeInBytes = await directorySize(artifactDirectory);
  const limitInBytes = limitInMegabytes * 1024 * 1024;

  if (sizeInBytes > limitInBytes) {
    throw new Error(
      `${artifactName} uncompressed size ${(sizeInBytes / 1024 / 1024).toFixed(1)} MB exceeds its ${limitInMegabytes} MB budget.`,
    );
  }

  process.stdout.write(
    `${artifactName}: ${(sizeInBytes / 1024 / 1024).toFixed(1)} MB / ${limitInMegabytes} MB\n`,
  );
}
