import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
// eslint-disable-next-line import/extensions -- pdfjs-dist only exposes the legacy ESM build file.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { closeBrowser, getBrowser } from '../../src/shared/pdf/browser';
import { renderPdfHtml } from '../../src/workers/processors/pdf-documents';

const arabicFixture = 'السلام عليكم';
const expectedShapedGlyphs = '\uFEE2\uFEDC\uFEE0\uFECB\u0644\u0627\u0645\uFEB4\uFEDF\u0627';
let testBrowser: Browser | undefined;
let usingSharedBrowser = false;

const getBrowserExecutablePath = (): string | undefined => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  if (process.platform !== 'win32') {
    return undefined;
  }

  return [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ]
    .filter((directory): directory is string => Boolean(directory))
    .map((directory) => join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    .find(existsSync);
};

describe('Arabic PDF rendering', () => {
  afterAll(async () => {
    if (usingSharedBrowser) {
      await closeBrowser();
    } else if (testBrowser) {
      await testBrowser.close();
    }
  });

  it('renders bundled Arabic fonts and extracts the shaped Arabic text from the PDF', async () => {
    const executablePath = getBrowserExecutablePath();

    if (executablePath) {
      testBrowser = await puppeteer.launch({
        executablePath,
        args: ['--no-sandbox'],
        headless: true,
      });
    } else {
      testBrowser = await getBrowser();
      usingSharedBrowser = true;
    }

    const page = await testBrowser.newPage();

    try {
      await page.setContent(
        renderPdfHtml({
          title: 'Arabic fixture',
          locale: 'fr',
          documentType: 'LEASE',
          generatedAt: '2026-10-31T10:00:00.000Z',
          sections: [{ title: 'Fixture', values: [{ label: 'Arabic text', value: arabicFixture }] }],
        }),
        { waitUntil: 'load', timeout: 10_000 },
      );
      await page.evaluate('document.fonts.ready');
      expect(
        await page.evaluate(
          'Array.from(document.fonts).find((font) => font.family === "Noto Naskh Arabic")?.status',
        ),
      ).toBe('loaded');

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      const loadingTask = getDocument({ data: Uint8Array.from(pdf) });
      const document = await loadingTask.promise;

      try {
        const pages = await Promise.all(
          Array.from({ length: document.numPages }, async (_, index) => {
            const pageContent = await (await document.getPage(index + 1)).getTextContent();

            return pageContent.items
              .filter((item) => 'str' in item)
              .map((item) => item.str)
              .join(' ');
          }),
        );
        const extractedText = pages.join(' ');
        const extractedArabicGlyphs = [...extractedText]
          .filter((character) => /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(character))
          .join('');

        expect(extractedArabicGlyphs).toContain(expectedShapedGlyphs);
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      await page.close();
    }
  });
});
