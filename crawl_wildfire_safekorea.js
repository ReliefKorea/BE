// Compatibility wrapper: the wildfire crawler now uses the Korea Forest Service
// public forest-fire list API because it provides both start and extinguish times.
const forestFireCrawler = require('./crawl_wildfire_forest_fd');

if (require.main === module) {
    forestFireCrawler.main().catch(() => {
        process.exitCode = 1;
    });
}

module.exports = forestFireCrawler;