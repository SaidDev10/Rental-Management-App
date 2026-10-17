import { ZipArchive } from 'archiver';
import { build } from 'esbuild';
import { createWriteStream, cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';

const root = process.cwd();

const entries = {
  'api-handler': 'src/lambdas/api-handler.ts',
  authorizer: 'src/lambdas/authorizer.ts',
  'pdf-worker': 'src/lambdas/pdf-worker.ts',
  'report-worker': 'src/lambdas/report-worker.ts',
  'notification-worker': 'src/lambdas/notification-worker.ts',
  'stream-aggregator': 'src/lambdas/stream-aggregator.ts',
} as const;

type ArtifactName = keyof typeof entries;

const externals: Partial<Record<ArtifactName, string[]>> = {
  'api-handler': ['@node-rs/argon2'],
  'pdf-worker': ['@sparticuz/chromium'],
  'report-worker': ['@sparticuz/chromium'],
};

const resolvePackageDirectory = (packageName: string, fromDirectory: string): string => {
  const resolvedEntry = createRequire(path.join(fromDirectory, 'package.json')).resolve(packageName);
  let currentDirectory = path.dirname(resolvedEntry);

  while (currentDirectory !== path.dirname(currentDirectory)) {
    const packageJsonPath = path.join(currentDirectory, 'package.json');

    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };

      if (manifest.name === packageName) {
        return realpathSync(currentDirectory);
      }
    } catch {
      // Continue walking until the owning package is found.
    }

    currentDirectory = path.dirname(currentDirectory);
  }

  throw new Error(`Could not locate the package directory for "${packageName}".`);
};

const copyRuntimePackage = (
  packageName: string,
  fromDirectory: string,
  destinationDirectory: string,
  visited: Set<string>,
): void => {
  const sourceDirectory = resolvePackageDirectory(packageName, fromDirectory);

  if (visited.has(sourceDirectory)) {
    return;
  }

  visited.add(sourceDirectory);
  mkdirSync(destinationDirectory, { recursive: true });
  cpSync(sourceDirectory, destinationDirectory, {
    recursive: true,
    dereference: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });

  const manifest = JSON.parse(
    readFileSync(path.join(sourceDirectory, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    const dependencyDirectory = path.join(destinationDirectory, 'node_modules', dependencyName);

    copyRuntimePackage(dependencyName, sourceDirectory, dependencyDirectory, visited);
  }

  for (const dependencyName of Object.keys(manifest.optionalDependencies ?? {})) {
    try {
      const dependencyDirectory = path.join(destinationDirectory, 'node_modules', dependencyName);

      copyRuntimePackage(dependencyName, sourceDirectory, dependencyDirectory, visited);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot find module')) {
        continue;
      }

      throw error;
    }
  }

  visited.delete(sourceDirectory);
};

const artifactNames = Object.keys(entries) as ArtifactName[];

const buildArtifact = async (artifactName: ArtifactName): Promise<void> => {
  const outputDirectory = path.join(root, 'dist', artifactName);
  const zipPath = path.join(root, 'dist', `${artifactName}.zip`);

  rmSync(outputDirectory, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(outputDirectory, { recursive: true });

  await build({
    entryPoints: [path.join(root, entries[artifactName])],
    outfile: path.join(outputDirectory, `${artifactName}.mjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: externals[artifactName] ?? [],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    minify: true,
  });

  for (const packageName of externals[artifactName] ?? []) {
    const packageDirectory = path.join(outputDirectory, 'node_modules', packageName);

    copyRuntimePackage(packageName, root, packageDirectory, new Set());
  }

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = createWriteStream(zipPath);
  const archiveWritten = finished(output);

  archive.on('warning', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw error;
    }

    throw error;
  });
  archive.on('error', (error: Error) => {
    throw error;
  });
  archive.pipe(output);
  archive.directory(outputDirectory, false);
  await archive.finalize();
  await archiveWritten;
};

const requestedArtifact = process.argv[2];

if (requestedArtifact !== undefined && !artifactNames.includes(requestedArtifact as ArtifactName)) {
  throw new Error(`Unknown Lambda artifact "${requestedArtifact}".`);
}

for (const artifactName of requestedArtifact ? [requestedArtifact as ArtifactName] : artifactNames) {
  await buildArtifact(artifactName);
}
