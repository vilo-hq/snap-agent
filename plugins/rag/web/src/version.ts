import pkg from '../package.json';

/**
 * Which extraction produced a stored page: the SDK's own version. The host only skips re-extracting a
 * page whose raw HTML did not change when the stored copy came from this same version (see
 * `CrawlLedgerDocument.extractorVersion`), so a release that reads pages differently reaches every page
 * once — re-embedding only the ones whose document really changed.
 */
export const EXTRACTOR_VERSION: string = pkg.version;
