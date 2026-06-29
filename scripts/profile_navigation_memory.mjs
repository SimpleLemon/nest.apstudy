import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const MB = 1024 * 1024;

function parseArgs(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:8000',
    noteUrl: '',
    cycles: 10,
    storageState: '',
    headed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--base-url' && next) options.baseUrl = next, index += 1;
    else if (arg === '--note-url' && next) options.noteUrl = next, index += 1;
    else if (arg === '--cycles' && next) options.cycles = Number(next), index += 1;
    else if (arg === '--storage-state' && next) options.storageState = next, index += 1;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: npm run test:memory -- --note-url /notes/<id> [options]',
    '',
    'Options:',
    '  --base-url <url>       App origin (default http://127.0.0.1:8000)',
    '  --note-url <url>       Authenticated note editor path or absolute URL',
    '  --cycles <count>       Measured cycles after two warmups (default 10)',
    '  --storage-state <file> Playwright authentication state',
    '  --headed               Show Chromium even when storage state is supplied',
  ].join('\n');
}

function absoluteUrl(baseUrl, candidate) {
  return new URL(candidate, baseUrl).href;
}

function metricValue(metrics, name) {
  return metrics.metrics.find((metric) => metric.name === name)?.value ?? 0;
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

function rendererRssBytes(processInfo) {
  const renderers = processInfo.filter((entry) => entry.type === 'renderer');
  const privateMemory = renderers.map((entry) => Number(entry.privateMemory || 0));
  if (privateMemory.some((value) => value > 0)) {
    return privateMemory.reduce((sum, value) => sum + value, 0);
  }

  const pids = renderers.map((entry) => Number(entry.id)).filter(Number.isFinite);
  if (!pids.length || !['darwin', 'linux'].includes(process.platform)) return 0;
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return output
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Number.isFinite)
      .reduce((sum, kilobytes) => sum + kilobytes * 1024, 0);
  } catch (_error) {
    return 0;
  }
}

async function takeHeapSnapshot(client, outputPath) {
  const chunks = [];
  const onChunk = ({ chunk }) => chunks.push(chunk);
  client.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    await writeFile(outputPath, chunks.join(''));
  } finally {
    client.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
}

async function navigateCycle(page, noteUrl) {
  await page.goto(noteUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#blocknote-root').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(500);

  const dashboardItem = page.locator('.sidebar-item[data-route="/dashboard"]');
  if (await dashboardItem.count()) {
    await dashboardItem.first().click();
  } else {
    await page.evaluate(() => window.APStudyNavigation.go('/dashboard'));
  }
  await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 30_000 });
  await page.locator('#dashboard-tiles').waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function sampleMemory(page, pageClient, browserClient, cycle) {
  await pageClient.send('HeapProfiler.collectGarbage');
  const [metrics, dom, processResponse, lifecycle, eventSources] = await Promise.all([
    pageClient.send('Performance.getMetrics'),
    pageClient.send('Memory.getDOMCounters'),
    browserClient.send('SystemInfo.getProcessInfo'),
    page.evaluate(() => {
      try {
        return JSON.parse(sessionStorage.getItem('apstudy-memory-lifecycle') || '[]');
      } catch (_error) {
        return [];
      }
    }),
    page.evaluate(() => window.__apstudyActiveEventSources || 0),
  ]);
  return {
    cycle,
    jsHeapUsedBytes: metricValue(metrics, 'JSHeapUsedSize'),
    jsHeapTotalBytes: metricValue(metrics, 'JSHeapTotalSize'),
    documents: dom.documents,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    rendererRssBytes: rendererRssBytes(processResponse.processInfo || []),
    activeEventSources: eventSources,
    lifecycleEvents: lifecycle.length,
    persistedPageHides: lifecycle.filter((event) => event.type === 'pagehide' && event.persisted).length,
    persistedPageShows: lifecycle.filter((event) => event.type === 'pageshow' && event.persisted).length,
  };
}

function megabytes(bytes) {
  return Math.round((bytes / MB) * 100) / 100;
}

function printSample(sample) {
  const rss = sample.rendererRssBytes ? `${megabytes(sample.rendererRssBytes)} MB RSS` : 'RSS unavailable';
  console.log(
    `cycle ${sample.cycle}: ${megabytes(sample.jsHeapUsedBytes)} MB heap, ${rss}, ` +
    `${sample.nodes} nodes, ${sample.listeners} listeners, ${sample.activeEventSources} EventSources`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (!options.noteUrl) throw new Error(`--note-url is required.\n\n${usage()}`);
  if (!Number.isInteger(options.cycles) || options.cycles < 3) throw new Error('--cycles must be an integer of at least 3.');

  const noteUrl = absoluteUrl(options.baseUrl, options.noteUrl);
  const outputDir = path.join(os.tmpdir(), `nest-memory-profile-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({
    headless: options.storageState ? !options.headed : false,
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const context = await browser.newContext(options.storageState ? { storageState: options.storageState } : {});
  await context.addInitScript(() => {
    const recordLifecycle = (type, event) => {
      try {
        const key = 'apstudy-memory-lifecycle';
        const events = JSON.parse(sessionStorage.getItem(key) || '[]');
        events.push({ type, persisted: Boolean(event.persisted), at: Date.now(), path: location.pathname });
        sessionStorage.setItem(key, JSON.stringify(events.slice(-200)));
      } catch (_error) {
        // Cross-origin login pages can deny storage access.
      }
    };
    addEventListener('pagehide', (event) => recordLifecycle('pagehide', event));
    addEventListener('pageshow', (event) => recordLifecycle('pageshow', event));

    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource === 'function') {
      window.__apstudyActiveEventSources = 0;
      window.EventSource = class InstrumentedEventSource extends NativeEventSource {
        constructor(...args) {
          super(...args);
          this.__apstudyClosed = false;
          window.__apstudyActiveEventSources += 1;
        }
        close() {
          if (!this.__apstudyClosed) {
            this.__apstudyClosed = true;
            window.__apstudyActiveEventSources = Math.max(0, window.__apstudyActiveEventSources - 1);
          }
          return super.close();
        }
      };
    }
  });

  const page = await context.newPage();
  await page.goto(noteUrl, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname.startsWith('/login')) {
    console.log('Complete OAuth login in the opened Chromium window; profiling will continue automatically.');
    await page.waitForURL((url) => url.origin === new URL(options.baseUrl).origin && !url.pathname.startsWith('/login'), {
      timeout: 5 * 60_000,
    });
  }

  const pageClient = await context.newCDPSession(page);
  const browserClient = await browser.newBrowserCDPSession();
  await pageClient.send('Performance.enable');
  await pageClient.send('HeapProfiler.enable');

  console.log('Running 2 warm-up navigation cycles...');
  for (let cycle = 1; cycle <= 2; cycle += 1) await navigateCycle(page, noteUrl);

  const baselineSnapshotPath = path.join(outputDir, 'baseline.heapsnapshot');
  await takeHeapSnapshot(pageClient, baselineSnapshotPath);
  const samples = [];
  const baseline = await sampleMemory(page, pageClient, browserClient, 0);
  samples.push(baseline);
  printSample(baseline);

  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    await navigateCycle(page, noteUrl);
    const sample = await sampleMemory(page, pageClient, browserClient, cycle);
    samples.push(sample);
    printSample(sample);
  }

  const measured = samples.slice(1);
  const final = measured.at(-1);
  const heapGrowthMb = megabytes(final.jsHeapUsedBytes - baseline.jsHeapUsedBytes);
  const rssGrowthMb = final.rendererRssBytes && baseline.rendererRssBytes
    ? megabytes(final.rendererRssBytes - baseline.rendererRssBytes)
    : 0;
  const rssSlopeMb = linearSlope(measured.map((sample) => sample.rendererRssBytes / MB));
  const nodeLimit = Math.ceil(baseline.nodes * 1.1 + 100);
  const nodesGrowEveryCycle = measured.length > 1
    && measured.every((sample, index) => index === 0 || sample.nodes > measured[index - 1].nodes);
  const failures = [];
  if (heapGrowthMb > 5) failures.push(`forced-GC heap grew ${heapGrowthMb} MB (limit 5 MB)`);
  if (final.rendererRssBytes && rssSlopeMb >= 1) failures.push(`renderer RSS slope was ${rssSlopeMb.toFixed(2)} MB/cycle (limit <1)`);
  if (final.rendererRssBytes && rssGrowthMb > 30) failures.push(`renderer RSS grew ${rssGrowthMb} MB (limit 30 MB)`);
  if (final.nodes > nodeLimit) failures.push(`DOM nodes ended at ${final.nodes} (limit ${nodeLimit})`);
  if (nodesGrowEveryCycle) failures.push('DOM node count grew monotonically across every measured cycle');
  if (measured.some((sample) => sample.activeEventSources !== 0)) failures.push('an EventSource remained active on Dashboard');

  const report = {
    options: { ...options, storageState: options.storageState ? '[provided]' : '' },
    thresholds: { heapGrowthMb: 5, rendererRssSlopeMbPerCycle: 1, rendererRssGrowthMb: 30, nodeLimit },
    results: { heapGrowthMb, rendererRssSlopeMbPerCycle: rssSlopeMb, rendererRssGrowthMb: rssGrowthMb },
    samples,
    failures,
  };

  if (failures.length) {
    await takeHeapSnapshot(pageClient, path.join(outputDir, 'final.heapsnapshot'));
    await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Memory profile failed. Diagnostics: ${outputDir}`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('Memory profile passed.');
    await rm(outputDir, { recursive: true, force: true });
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
