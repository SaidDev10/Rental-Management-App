import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';
import path from 'node:path';

let browserPromise: Promise<Browser> | undefined;

const getBrowserInstance = async (fontFiles: readonly string[] = []): Promise<Browser> => {
  browserPromise ??= (async () => {
    await Promise.all(fontFiles.map((fontFile) => chromium.font(fontFile)));

    return puppeteer.launch({
      args: [...chromium.args, '--font-render-hinting=none', '--disable-dev-shm-usage'],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  })();

  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = undefined;

    throw error;
  }
};

export const getBrowser = (): Promise<Browser> => getBrowserInstance();

export const getPdfBrowser = (): Promise<Browser> => {
  const assetRoot = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
  const fontFiles = [
    'Inter-Variable.ttf',
    'NotoNaskhArabic-Variable.ttf',
    'NotoSans-Variable.ttf',
  ].map((file) => path.join(assetRoot, 'assets', 'fonts', file));

  return getBrowserInstance(fontFiles);
};

export const closeBrowser = async (): Promise<void> => {
  const currentBrowser = browserPromise;
  browserPromise = undefined;

  if (currentBrowser) {
    await (await currentBrowser).close();
  }
};
