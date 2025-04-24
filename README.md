# Shopify Product Crawler

A powerful and efficient web crawler designed to extract product data from Shopify stores using XML sitemaps as the starting point.

## Features

- Uses XML sitemaps to discover all collection pages
- Crawls collections one by one, with resumable progress
- Extracts comprehensive product details:
  - Title, description, handle, URL
  - Price, compare-at price, sale status
  - High-resolution product images
  - Variants with all options
  - Product type, vendor, tags, and categories
- Processes the crawled data to generate insights and statistics
- Step-by-step approach for better reliability and control

## Usage

### Sitemap-based Crawler

The sitemap crawler (`sitemap_crawler.js`) uses a Shopify store's XML sitemap to extract collection URLs and then crawls each collection for products.

```bash
node sitemap_crawler.js --sitemap sitemap_collections_1.xml
```

Options:
- `--sitemap, -s`: Path to sitemap XML file (default: `sitemap_collections_1.xml`)
- `--output, -o`: Output JSON file path (default: `shopify_products.json`)
- `--start`: Start from collection index (0-based) (default: 0)
- `--limit, -l`: Maximum collections to crawl (0 for all) (default: 0)
- `--products-per-collection, -p`: Maximum products to crawl per collection (0 for all) (default: 0)
- `--timeout, -t`: Navigation timeout in milliseconds (default: 90000)
- `--delay, -d`: Delay between requests in milliseconds (default: 1000)
- `--save-interval`: Save progress after crawling this many products (default: 5)

Example for limited crawling (for testing):
```bash
node sitemap_crawler.js --limit 2 --products-per-collection 5 --save-interval 1 --delay 2000
```

### Data Processor

The data processor (`process-data.js`) analyzes the crawled product data and generates statistics and categorized views:

```bash
node process-data.js
```

Options:
- `--input, -i`: Input JSON file with crawled products (default: `shopify_products.json`)
- `--output, -o`: Output directory for processed data (default: `processed_data`)
- `--format, -f`: Output format (json, csv) (default: `json`)

## Output Files

The crawler generates a JSON file with all product data. The processor generates several JSON files with different views of the data:

- `stats.json`: General statistics about products, collections, prices, etc.
- `collections_data.json`: Products grouped by collection with collection-specific stats
- `categorized_products.json`: Products categorized by type, vendor, and sale status
- `price_ranges.json`: Products grouped by price range

## How It Works

1. **Sitemap Parsing**: The crawler first parses the provided Shopify sitemap XML file to extract all collection URLs.

2. **Collection Discovery**: For each collection URL, the crawler navigates to the page and extracts product links.

3. **Product Extraction**: For each product link, the crawler navigates to the product page and extracts detailed information including:
   - Basic product info (title, description, handle, URL)
   - Price information (regular price, compare-at price, sale status)
   - High-resolution product images
   - Variant details (options, prices, availability)
   - Metadata (product type, vendor, tags, etc.)

4. **Progress Saving**: The crawler regularly saves its progress, allowing for resumable crawling sessions.

5. **Data Processing**: The data processor script analyzes the collected data to generate insights and statistics.

## Dependencies

- puppeteer: For browser automation and web scraping
- fs-extra: Enhanced file system operations
- yargs: Command-line argument parsing
- xml2js: XML parsing for sitemaps

## Limitations

- The crawler respects website performance by waiting between requests (configurable delay)
- Some Shopify themes may have unique structures requiring crawler adjustments
- Always ensure you have permission to crawl a website before using this tool 