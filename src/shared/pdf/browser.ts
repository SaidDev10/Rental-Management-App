import chromium from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';

let browserPromise: Promise<Browser> | undefined;

export const getBrowser = async (): Promise<Browser> => {
  browserPromise ??= (async () => {
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

export const closeBrowser = async (): Promise<void> => {
  const currentBrowser = browserPromise;
  browserPromise = undefined;

  if (currentBrowser) {
    await (await currentBrowser).close();
  }
};
