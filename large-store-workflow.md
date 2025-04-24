# Step-by-Step Guide for Crawling Large Shopify Stores

This guide outlines the process for crawling large Shopify stores in a controlled, step-by-step manner using our sitemap-based crawler.

## 1. Preparation

Before starting the crawl, make sure you have:

- Node.js installed (v14 or higher)
- All required dependencies installed:
  ```bash
  npm install puppeteer fs-extra yargs xml2js
  ```
- The store's sitemap XML file:
  - Usually located at `https://store-domain.com/sitemap.xml`
  - Look for a sitemap file specifically for collections (e.g., `sitemap_collections_1.xml`)
  - Download and save it locally

## 2. Initial Test Crawl

Start with a small test to confirm everything works properly:

```bash
node sitemap_crawler.js --sitemap sitemap_collections_1.xml --limit 2 --products-per-collection 5 --save-interval 1
```

This will:
- Crawl the first 2 collections from the sitemap
- Get up to 5 products from each collection
- Save progress after each product

Check the output file (`shopify_products.json`) to verify the data is correct.

## 3. Crawl in Batches

For a large store, crawl collections in batches to prevent timeouts and memory issues:

### Batch 1 (Collections 0-9)
```bash
node sitemap_crawler.js --sitemap sitemap_collections_1.xml --start 0 --limit 10 --save-interval 10
```

### Batch 2 (Collections 10-19)
```bash
node sitemap_crawler.js --sitemap sitemap_collections_1.xml --start 10 --limit 10 --save-interval 10
```

### Continue with more batches as needed
Adjust the `--start` parameter accordingly for each batch:
```bash
node sitemap_crawler.js --sitemap sitemap_collections_1.xml --start 20 --limit 10 --save-interval 10
```

The crawler will automatically:
- Skip products that have already been crawled
- Add new products to the existing output file
- Update collection status in the output file

## 4. Handle Failed Collections

If some collections fail during crawling, you can retry them specifically:

1. Check the output file to identify failed collections
2. Create a targeted crawl for those collections:
   ```bash
   node sitemap_crawler.js --sitemap sitemap_collections_1.xml --limit 1 --start [collection_index]
   ```

## 5. Process the Crawled Data

After completing the crawl, process the data to generate insights:

```bash
node process-data.js
```

This will create several output files in the `processed_data` directory:
- `stats.json`: Overall statistics about products and collections
- `collections_data.json`: Products organized by collection
- `categorized_products.json`: Products categorized by type, vendor, and sale status
- `price_ranges.json`: Products grouped by price range

## 6. Optimization Tips

To improve reliability for very large stores:

1. **Adjust delay between requests** to avoid being rate-limited:
   ```bash
   node sitemap_crawler.js --delay 2000  # 2 seconds between requests
   ```

2. **Set longer timeouts** for slow-loading pages:
   ```bash
   node sitemap_crawler.js --timeout 120000  # 2 minutes timeout
   ```

3. **Run during off-peak hours** to reduce server load.

4. **Use a headful browser** for debugging if needed:
   ```bash
   # Edit the puppeteer.launch() call in sitemap_crawler.js
   # Change headless: "new" to headless: false
   ```

## 7. API-Based Alternative

If you have access to the Shopify Storefront API, use the API-based crawler for more reliability:

```bash
node api-crawler.js --store your-store.myshopify.com --access_token your-storefront-api-token
```

This method is:
- Faster and more reliable
- Less likely to be blocked
- More accurate for certain data like variants and prices

## 8. Combining Multiple Methods

For the most comprehensive results, consider:

1. Use the sitemap crawler to discover all collections and products
2. Use the API crawler to fetch detailed product information
3. Merge the results for a complete dataset

This approach provides the breadth of web scraping with the accuracy of API data. 