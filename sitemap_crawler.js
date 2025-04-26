import fs from 'fs-extra';
import puppeteer from 'puppeteer';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseStringPromise } from 'xml2js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('sitemap', {
    alias: 's',
    description: 'Sitemap XML file path',
    type: 'string',
    default: 'sitemap_collections_1.xml'
  })
  .option('output-dir', {
    alias: 'o',
    description: 'Output directory for category JSON files',
    type: 'string',
    default: 'processed_data/categories'
  })
  .option('timeout', {
    alias: 't',
    description: 'Navigation timeout in milliseconds',
    type: 'number',
    default: 90000
  })
  .option('retries', {
    alias: 'r',
    description: 'Number of retries for failed page loads',
    type: 'number',
    default: 3
  })
  .option('delay', {
    alias: 'd',
    description: 'Delay between requests in milliseconds',
    type: 'number',
    default: 1000
  })
  .option('max-pages', {
    alias: 'p',
    description: 'Maximum pages per collection to crawl (0 for all pages)',
    type: 'number',
    default: 0
  })
  .option('debug-collection', {
    description: 'Crawl only a specific collection',
    type: 'string',
    default: ''
  })
  .option('wait-time', {
    description: 'Time to wait after page load in milliseconds',
    type: 'number',
    default: 2000
  })
  .option('save-html', {
    description: 'Save HTML content of pages for debugging',
    type: 'boolean',
    default: false
  })
  .help()
  .alias('help', 'h')
  .argv;

/**
 * Helper function to navigate to a URL with retries
 */
async function safeNavigate(page, url, options = {}) {
  const retries = options.retries || argv.retries;
  const timeout = options.timeout || argv.timeout;
  const waitUntil = options.waitUntil || 'domcontentloaded';
  
  let lastError;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // First try with longer timeout
      const response = await page.goto(url, { 
        timeout: timeout,
        waitUntil: waitUntil
      });
      
      // If we get here, navigation succeeded
      if (attempt > 1) {
        console.log(`Successfully loaded ${url} on attempt ${attempt}`);
      }
      
      // Wait a bit more for dynamic content if needed
      try {
        await page.waitForSelector('body', { timeout: 5000 });
        // Add wait time for JavaScript to load content
        await new Promise(resolve => setTimeout(resolve, argv['wait-time']));
      } catch (e) {
        // It's okay if this times out
      }
      
      return response;
    } catch (error) {
      lastError = error;
      console.error(`Navigation attempt ${attempt}/${retries} to ${url} failed: ${error.message}`);
      
      // Wait before retry
      if (attempt < retries) {
        const waitTime = 2000 * attempt; // Increasing backoff
        console.log(`Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // If we get here, all retries failed
  throw new Error(`Failed to navigate to ${url} after ${retries} attempts: ${lastError.message}`);
}

/**
 * Function to save data to JSON file
 */
async function saveToJson(data, filename) {
  try {
    await fs.ensureFile(filename);
    await fs.writeJSON(filename, data, { spaces: 2 });
    console.log(`Data saved to ${filename}`);
  } catch (error) {
    console.error(`Error saving data: ${error.message}`);
  }
}

/**
 * Read and parse sitemap XML file
 */
async function parseSitemap(sitemapFile) {
  try {
    console.log(`Reading sitemap file: ${sitemapFile}`);
    const xmlData = await fs.readFile(sitemapFile, 'utf-8');
    
    const result = await parseStringPromise(xmlData, {
      trim: true,
      explicitArray: false
    });
    
    if (!result.urlset || !result.urlset.url) {
      throw new Error('Invalid sitemap format');
    }
    
    // Ensure url is always an array
    const urls = Array.isArray(result.urlset.url) ? result.urlset.url : [result.urlset.url];
    
    // Extract collection URLs
    const collections = urls.map(item => ({
      url: item.loc,
      lastmod: item.lastmod,
      changefreq: item.changefreq,
      image: item['image:image'] ? {
        url: item['image:image']['image:loc'],
        title: item['image:image']['image:title'],
        caption: item['image:image']['image:caption']
      } : null,
      handle: extractCollectionHandle(item.loc)
    }));
    
    console.log(`Found ${collections.length} collections in sitemap`);
    
    // Print all collection handles for debugging
    console.log('Available collections:');
    collections.slice(0, 10).forEach(c => console.log(`- ${c.handle}`));
    if (collections.length > 10) {
      console.log(`... and ${collections.length - 10} more`);
    }
    
    return collections;
  } catch (error) {
    console.error(`Error parsing sitemap: ${error.message}`);
    return [];
  }
}

/**
 * Extract collection handle from URL
 */
function extractCollectionHandle(url) {
  const match = url.match(/\/collections\/([^\/]+)/);
  return match ? match[1] : null;
}

/**
 * Save HTML content for debugging
 */
async function saveHtmlContent(page, filename) {
  if (!argv['save-html']) return;
  
  try {
    const html = await page.content();
    const outputDir = path.join(argv['output-dir'], 'debug');
    await fs.ensureDir(outputDir);
    await fs.writeFile(path.join(outputDir, filename), html);
    console.log(`Saved HTML content to ${filename}`);
  } catch (error) {
    console.error(`Error saving HTML: ${error.message}`);
  }
}

/**
 * Crawl products from a collection
 */
async function crawlCollection(page, collection) {
  try {
    console.log(`\nCrawling collection: ${collection.handle} (${collection.url})`);
    
    // Navigate to collection page
    await safeNavigate(page, collection.url);
    console.log(`Successfully loaded collection page`);
    
    // Save HTML for debugging
    await saveHtmlContent(page, `${collection.handle}_page1.html`);
    
    // Get total pages in this collection
    let totalPages = 1;
    try {
      // First check for pagination elements in the DOM
      const paginationSelector = '.pagination, .pagination-wrapper, nav[role="navigation"], .pager, .pages, ul.page-numbers, .paginate, .pgn, [data-pagination], [class*="pagination"]';
      const hasPagination = await page.$(paginationSelector);
      
      if (hasPagination) {
        const pageNumbersText = await page.evaluate(() => {
          const paginationEl = document.querySelector('.pagination, .pagination-wrapper, nav[role="navigation"], .pager, .pages, ul.page-numbers, .paginate, .pgn, [data-pagination], [class*="pagination"]');
          if (!paginationEl) return null;
          const pageNumbers = Array.from(paginationEl.querySelectorAll('span, a'))
            .map(el => el.textContent.trim())
            .filter(text => !isNaN(parseInt(text)));
          return pageNumbers;
        });
        
        if (pageNumbersText && pageNumbersText.length > 0) {
          const pageNumbers = pageNumbersText.map(p => parseInt(p));
          totalPages = Math.max(...pageNumbers);
        }
      } 
      
      // If no pagination found via DOM elements, check for link rel="next" tags
      if (totalPages === 1) {
        const hasNextLink = await page.evaluate(() => {
          const nextLink = document.querySelector('link[rel="next"]');
          if (nextLink) {
            // Try to extract page number from URL
            const url = nextLink.getAttribute('href');
            const match = url.match(/[?&]page=(\d+)/);
            if (match && match[1]) {
              return parseInt(match[1]);
            }
            return 2; // If we can't extract the page number, assume at least 2 pages
          }
          return null;
        });
        
        if (hasNextLink) {
          // We found a next link, so we have at least 2 pages
          // Let's crawl up to 10 pages to find the last page
          let currentPage = 2;
          let nextUrl = await page.evaluate(() => {
            return document.querySelector('link[rel="next"]').getAttribute('href');
          });
          
          // Convert relative URL to absolute
          if (nextUrl.startsWith('/')) {
            nextUrl = new URL(nextUrl, page.url()).href;
          }
          
          console.log(`Found next page link to: ${nextUrl}`);
          
          while (currentPage <= 10) {
            try {
              // Navigate to next page
              await safeNavigate(page, nextUrl);
              console.log(`Checking pagination on page ${currentPage}`);
              
              // Save HTML for debugging
              await saveHtmlContent(page, `${collection.handle}_page${currentPage}.html`);
              
              // Check if there's a next link on this page
              const hasMorePages = await page.evaluate(() => {
                const nextLink = document.querySelector('link[rel="next"]');
                if (nextLink) {
                  return nextLink.getAttribute('href');
                }
                return null;
              });
              
              if (hasMorePages) {
                currentPage++;
                nextUrl = hasMorePages;
                
                // Convert relative URL to absolute
                if (nextUrl.startsWith('/')) {
                  nextUrl = new URL(nextUrl, page.url()).href;
                }
                
                console.log(`Found another page: ${nextUrl}`);
              } else {
                // No more pages, we reached the end
                totalPages = currentPage;
                break;
              }
            } catch (error) {
              console.error(`Error checking pagination: ${error.message}`);
              totalPages = currentPage - 1;
              break;
            }
          }
          
          if (currentPage > 10) {
            console.log(`Reached maximum pagination check limit of 10 pages`);
            totalPages = 10;
          }
          
          // Go back to first page
          await safeNavigate(page, collection.url);
        }
      }
    } catch (err) {
      console.log('No pagination found, assuming single page');
      console.error(err);
    }
    
    console.log(`Found ${totalPages} pages in this collection`);
    
    // Set max pages to crawl
    const maxPages = argv['max-pages'] > 0 ? Math.min(argv['max-pages'], totalPages) : totalPages;
    
    // Initialize result for this collection
    const collectionResult = {
      handle: collection.handle,
      url: collection.url,
      title: '',
      description: '',
      image: collection.image ? collection.image.url : null,
      products: [],
      totalProducts: 0,
      crawledAt: new Date().toISOString()
    };
    
    // Get collection title and description
    collectionResult.title = await page.evaluate(() => {
      return document.querySelector('h1, .collection-title, .collection-header h1')?.textContent.trim() || '';
    });
    
    collectionResult.description = await page.evaluate(() => {
      return document.querySelector('.collection-description, .collection__description')?.innerHTML.trim() || '';
    });
    
    // Track already crawled products to avoid duplicates
    const crawledProducts = new Map();
    
    // Crawl each page in this collection
    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      console.log(`Processing page ${currentPage}/${maxPages} of collection "${collection.handle}"`);
      
      if (currentPage > 1) {
        try {
          // First try standard page parameter
          const nextPageUrl = `${collection.url}?page=${currentPage}`;
          await safeNavigate(page, nextPageUrl);
          
          // Save HTML for debugging
          await saveHtmlContent(page, `${collection.handle}_page${currentPage}.html`);
          
          // If using link rel="next", we need to check if we got to the right page
          // by looking for the page number in the URL
          const currentUrl = await page.url();
          if (!currentUrl.includes(`page=${currentPage}`)) {
            console.log(`Navigation may have failed, current URL: ${currentUrl}`);
            
            // Try to find the correct link from pagination elements
            const foundLink = await page.evaluate((targetPage) => {
              // Check pagination links
              const paginationLinks = Array.from(document.querySelectorAll('.pagination a, .pagination-wrapper a, [role="navigation"] a'));
              for (const link of paginationLinks) {
                if (link.textContent.trim() === targetPage.toString() || 
                    link.href.includes(`page=${targetPage}`)) {
                  return link.href;
                }
              }
              return null;
            }, currentPage);
            
            if (foundLink) {
              console.log(`Found correct pagination link: ${foundLink}`);
              await safeNavigate(page, foundLink);
              await saveHtmlContent(page, `${collection.handle}_page${currentPage}_corrected.html`);
            }
          }
        } catch (error) {
          console.error(`Error navigating to page ${currentPage}: ${error.message}`);
          // Skip to next page on error
          continue;
        }
      }
      
      // Get all product links on this page
      const productLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a.product-card, a[href*="/products/"], [data-product-handle] a, .product-item a, .product-grid-item a, .product a, .collection-product a, .product__link, a[class*="product"], a[href*="product"]'))
          .filter(link => link.href && (link.href.includes('/products/') || link.href.includes('product')))
          .map(link => link.href);
      });
      
      // Remove duplicates
      const uniqueProductLinks = [...new Set(productLinks)];
      console.log(`Found ${uniqueProductLinks.length} products on page ${currentPage}`);
      
      // Process each product
      for (const [prodIndex, productUrl] of uniqueProductLinks.entries()) {
        try {
          // Extract product handle from URL to check if we've already crawled it
          const productHandle = productUrl.split('/products/')[1]?.split('?')[0];
          
          if (crawledProducts.has(productHandle)) {
            console.log(`Product "${productHandle}" already crawled, skipping...`);
            continue;
          }
          
          console.log(`Processing product ${prodIndex + 1}/${uniqueProductLinks.length}: ${productHandle}`);
          
          // Navigate to product page
          await safeNavigate(page, productUrl);
          console.log(`Successfully loaded product page`);
          
          // Extract product JSON from ProductJson-product-template script
          const productJsonData = await page.evaluate(() => {
            try {
              // Look for the script tag with product JSON data
              const scriptSelector = 'script#ProductJson-product-template, script#ProductJson-template, script[data-product-json]';
              const scriptElement = document.querySelector(scriptSelector);
              
              if (scriptElement) {
                // Parse the JSON content from the script tag
                const productJson = JSON.parse(scriptElement.textContent);
                return {
                  productJson,
                  found: true,
                  source: 'product-template'
                };
              }
              
              // Try alternative methods if the standard script tag is not found
              // Look for script tags with application/json type that might contain product data
              const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
              for (const script of jsonScripts) {
                try {
                  if (script.id && script.id.includes('Product')) {
                    const data = JSON.parse(script.textContent);
                    return {
                      productJson: data,
                      found: true,
                      source: script.id
                    };
                  }
                } catch (e) {
                  // Continue to next script if parsing fails
                }
              }
              
              // Look for inline product data in other script tags
              const allScripts = Array.from(document.querySelectorAll('script:not([src])'));
              for (const script of allScripts) {
                const content = script.textContent;
                
                // Try to find product JSON in various formats
                if (content.includes('var product =') || 
                    content.includes('window.product =') || 
                    content.includes('Product =')) {
                  
                  try {
                    // Extract product JSON from script content
                    const productMatch = content.match(/var\s+product\s*=\s*({[\s\S]*?});/) || 
                                       content.match(/window\.product\s*=\s*({[\s\S]*?});/) ||
                                       content.match(/Product\s*=\s*({[\s\S]*?});/);
                    
                    if (productMatch && productMatch[1]) {
                      // Clean the JSON string and parse it
                      const productJsonStr = productMatch[1].replace(/'/g, '"');
                      const productData = JSON.parse(productJsonStr);
                      
                      return {
                        productJson: productData,
                        found: true,
                        source: 'script-variable'
                      };
                    }
                  } catch (e) {
                    // Continue if parsing fails
                  }
                }
              }
              
              return {
                found: false,
                source: null
              };
            } catch (error) {
              return {
                found: false,
                error: error.message
              };
            }
          });
          
          // Log whether we found product JSON data
          if (productJsonData.found) {
            console.log(`Found product JSON data from source: ${productJsonData.source}`);
            console.log(`Product has ${productJsonData.productJson.variants ? productJsonData.productJson.variants.length : 0} variants and ${productJsonData.productJson.images ? productJsonData.productJson.images.length : 0} images`);
          } else {
            console.log('No product JSON data found in script tags, falling back to DOM scraping');
          }
          
          // Extract product details
          const productData = await page.evaluate((productJsonData) => {
            // Function to parse money values
            const parseMoney = (moneyString) => {
              if (!moneyString) return null;
              // Remove currency symbols and whitespace, handle different formats
              return parseFloat(moneyString.replace(/[^\d,.]/g, '')
                .replace(/,(\d{2})$/, '.$1')  // Handle comma as decimal separator in some locales
                .replace(/,/g, '')); // Remove thousands separators
            };
            
            try {
              // Initialize variables based on existing DOM content
              let title, description, price, compareAtPrice, onSale, images, variants, options;
              
              // Use the productJson data if found
              if (productJsonData && productJsonData.found && productJsonData.productJson) {
                const productJson = productJsonData.productJson;
                
                // Basic product information from JSON
                title = productJson.title || '';
                description = productJson.description || '';
                
                // Price information - Shopify sometimes stores prices in cents
                if (productJson.price_min !== undefined) {
                  // Price is already in dollars format
                  price = productJson.price_min / 100;
                  compareAtPrice = productJson.compare_at_price_min ? productJson.compare_at_price_min / 100 : null;
                } else if (productJson.price !== undefined) {
                  // Handle case where price might be in cents
                  if (productJson.price > 10000) {
                    // Likely in cents
                    price = productJson.price / 100;
                    compareAtPrice = productJson.compare_at_price ? productJson.compare_at_price / 100 : null;
                  } else {
                    // Likely already in dollars
                    price = productJson.price;
                    compareAtPrice = productJson.compare_at_price || null;
                  }
                }
                
                // On sale status
                onSale = compareAtPrice !== null && compareAtPrice > price;
                
                // Get all product images
                if (productJson.images && Array.isArray(productJson.images)) {
                  // Process image URLs
                  images = productJson.images.map(img => {
                    // Handle various image formats (string or object)
                    let imageUrl;
                    if (typeof img === 'string') {
                      imageUrl = img;
                    } else if (img.src) {
                      imageUrl = img.src;
                    } else {
                      return null;
                    }
                    
                    // Make relative URLs absolute
                    if (!imageUrl.startsWith('http')) {
                      imageUrl = new URL(imageUrl, window.location.origin).href;
                    }
                    
                    // For Shopify CDN images, try to get high resolution
                    if (imageUrl.includes('cdn.shopify.com')) {
                      imageUrl = imageUrl.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                    }
                    
                    return imageUrl;
                  }).filter(Boolean); // Remove null values
                } else {
                  images = [];
                }
                
                // Get product options
                if (productJson.options && Array.isArray(productJson.options)) {
                  options = productJson.options.map(opt => {
                    if (typeof opt === 'string') {
                      // Handle case where options might be just strings
                      return {
                        name: opt,
                        values: []
                      };
                    } else {
                      // Handle object format with name and values
                      return {
                        name: opt.name,
                        values: opt.values || []
                      };
                    }
                  });
                } else {
                  options = [];
                }
                
                // Process variants with images
                if (productJson.variants && Array.isArray(productJson.variants)) {
                  // Create a map of variant IDs to featured images
                  const variantImageMap = new Map();
                  
                  // Map variant IDs to images
                  if (productJson.images && Array.isArray(productJson.images)) {
                    productJson.images.forEach(img => {
                      if (img.variant_ids && Array.isArray(img.variant_ids)) {
                        const imageUrl = img.src;
                        // Make URL absolute and high-res
                        let fullImageUrl = imageUrl;
                        if (!fullImageUrl.startsWith('http')) {
                          fullImageUrl = new URL(fullImageUrl, window.location.origin).href;
                        }
                        
                        if (fullImageUrl.includes('cdn.shopify.com')) {
                          fullImageUrl = fullImageUrl.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                        }
                        
                        // Map this image to all its variant IDs
                        img.variant_ids.forEach(variantId => {
                          variantImageMap.set(variantId.toString(), fullImageUrl);
                        });
                      }
                    });
                  }
                  
                  // Process all variants
                  variants = productJson.variants.map(variant => {
                    // Get price (handle if in cents)
                    let variantPrice = variant.price;
                    if (variantPrice > 10000) {
                      variantPrice = variantPrice / 100;
                    }
                    
                    // Get compare at price
                    let variantComparePrice = variant.compare_at_price;
                    if (variantComparePrice > 10000) {
                      variantComparePrice = variantComparePrice / 100;
                    }
                    
                    // Try to get variant image from different sources
                    let variantImage = null;
                    
                    // Method 1: Check featured_image directly on variant
                    if (variant.featured_image && variant.featured_image.src) {
                      variantImage = variant.featured_image.src;
                      
                      // Make URL absolute and high-res
                      if (!variantImage.startsWith('http')) {
                        variantImage = new URL(variantImage, window.location.origin).href;
                      }
                      
                      if (variantImage.includes('cdn.shopify.com')) {
                        variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                      }
                    } 
                    // Method 2: Check variant ID in the image map
                    else if (variantImageMap.has(variant.id.toString())) {
                      variantImage = variantImageMap.get(variant.id.toString());
                    } 
                    // Method 3: Fall back to product's first image
                    else if (images && images.length > 0) {
                      variantImage = images[0];
                    }
                    
                    // Build variant object
                    return {
                      id: variant.id,
                      title: variant.title,
                      price: variantPrice || price,
                      compareAtPrice: variantComparePrice || null,
                      sku: variant.sku || '',
                      available: variant.available !== undefined ? variant.available : (variant.inventory_quantity > 0),
                      option1: variant.option1 || null,
                      option2: variant.option2 || null,
                      option3: variant.option3 || null,
                      options: [variant.option1, variant.option2, variant.option3].filter(Boolean),
                      image: variantImage
                    };
                  });
                } else {
                  variants = [];
                }
              }
              
              // If we didn't get data from JSON, fall back to DOM scraping
              if (!title) {
                // Collect all script tags for later use
                const scriptTags = Array.from(document.querySelectorAll('script:not([src])'));
                
                // Basic product info
                title = document.querySelector('h1, .product-title, .product__title')?.textContent.trim();
                
                // Get full description - try different selectors used by Shopify themes
                description = document.querySelector('.product__description')?.innerHTML.trim() || 
                             document.querySelector('.product-single__description')?.innerHTML.trim() || 
                             document.querySelector('[data-product-description]')?.innerHTML.trim() ||
                             document.querySelector('.product-description')?.innerHTML.trim() ||
                             document.querySelector('#product-description')?.innerHTML.trim() ||
                             document.querySelector('.description')?.innerHTML.trim() ||
                             document.querySelector('[itemprop="description"]')?.innerHTML.trim();
                
                // Price information
                price = null;
                compareAtPrice = null;
                onSale = false;
                
                // Try multiple selectors for price elements
                const priceElement = document.querySelector('.price, .product__price, [data-product-price], .product-price, .price__current, .product-single__price, .price--item, [data-item="price"], [itemprop="price"]');
                
                if (priceElement) {
                  // Remove hidden elements that might contain different prices
                  const priceText = priceElement.textContent.trim();
                  price = parseMoney(priceText);
                  
                  // Check for compare-at price (original price before discount)
                  const compareAtEl = document.querySelector('.price--compare-at, .product__price--compare, [data-compare-price], .compare-at-price, .product-compare-price, .price__old, .price--on-sale .price__sale, .product-single__price--compare, [data-item="comparePrice"]');
                                 
                  if (compareAtEl) {
                    const compareText = compareAtEl.textContent.trim();
                    compareAtPrice = parseMoney(compareText);
                    onSale = compareAtPrice > price;
                  }
                }
                
                // Get all product images with high resolution
                images = [];
                
                // Try to get images from structured data first
                const jsonLds = document.querySelectorAll('script[type="application/ld+json"]');
                let foundImagesInJson = false;
                
                for (const jsonLd of jsonLds) {
                  try {
                    const data = JSON.parse(jsonLd.textContent);
                    if (data && data['@type'] === 'Product' && data.image) {
                      if (Array.isArray(data.image)) {
                        // Process each image to ensure it's a full URL
                        data.image.forEach(img => {
                          if (typeof img === 'string') {
                            // Ensure it's an absolute URL
                            const fullUrl = new URL(img, window.location.origin).href;
                            images.push(fullUrl);
                          }
                        });
                      } else if (typeof data.image === 'string') {
                        // Ensure it's an absolute URL
                        const fullUrl = new URL(data.image, window.location.origin).href;
                        images.push(fullUrl);
                      }
                      foundImagesInJson = true;
                      break;
                    }
                  } catch (e) {
                    // Continue if JSON parsing fails
                  }
                }
                
                // If no images found in JSON-LD, try DOM
                if (!foundImagesInJson || images.length === 0) {
                  // Look for image elements
                  const imageSelectors = `
                    .product__media img, .product-single__media img, .product-image, .product__image, 
                    [data-product-image], .product-featured-img, .product-gallery__image img, 
                    .product-single__photo img, #ProductPhotoImg, .product-main-image, 
                    [data-zoom-image], .slick-slide img, .product__slide img, .swiper-slide img,
                    img[itemprop="image"], .fotorama__img, .product-gallery__image, 
                    .product-image-main img, .product_image img
                  `;
                  
                  const imageElements = document.querySelectorAll(imageSelectors);
                  
                  imageElements.forEach(img => {
                    // Try multiple sources for the image URL
                    let src = img.getAttribute('src') || 
                             img.getAttribute('data-src') || 
                             img.getAttribute('data-zoom-image') || 
                             img.getAttribute('data-full-resolution') || 
                             img.getAttribute('data-image') || 
                             img.getAttribute('data-zoom-src') || '';
                    
                    // For empty src but backgroundImage style
                    if (!src && img.style && img.style.backgroundImage) {
                      const bgMatch = img.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                      if (bgMatch && bgMatch[1]) {
                        src = bgMatch[1];
                      }
                    }
                    
                    // Skip if still no src
                    if (!src) return;
                    
                    // Make relative URLs absolute
                    if (src && !src.startsWith('http')) {
                      src = new URL(src, window.location.origin).href;
                    }
                    
                    // Try to get high resolution version
                    if (src.includes('_small') || src.includes('_medium') || src.includes('_large')) {
                      src = src.replace(/_(?:small|medium|large|compact|grande)\./, '.');
                    }
                    
                    // For Shopify CDN images, try to get the largest version
                    if (src.includes('cdn.shopify.com')) {
                      // Replace size parameter with 2048x2048 for high resolution
                      src = src.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                    }
                    
                    if (src && !images.includes(src)) {
                      images.push(src);
                    }
                  });
                }
                
                // Extract variants from DOM if not already set from JSON
                if (!variants || variants.length === 0) {
                  // Try to get variants from product form
                  const variantElements = document.querySelectorAll('.product-form__option, .single-option-selector, select[data-option], .swatch, [data-product-variants], .product-options, .js-product-options');
                  
                  if (variantElements.length > 0) {
                    options = Array.from(variantElements).map(el => {
                      const optionName = el.getAttribute('data-option-name') || 
                                       el.getAttribute('data-option') ||
                                       el.querySelector('label')?.textContent.trim() || 
                                       'Option';
                                       
                      const optionValues = Array.from(el.querySelectorAll('input, option, .swatch-element, [data-value]'))
                        .map(input => input.value || input.getAttribute('data-value') || input.textContent.trim())
                        .filter(v => v);
                        
                      return {
                        name: optionName,
                        values: optionValues
                      };
                    });
                    
                    // If we have option data but no variants, create basic variant objects
                    if (options.length > 0) {
                      // For simplicity, just create a dummy variant since we don't have accurate price data for each combination
                      variants = [{
                        title: 'Default Title',
                        price: price,
                        compareAtPrice: compareAtPrice,
                        available: true,
                        options: options,
                        // Add default image to the variant
                        image: images && images.length > 0 ? images[0] : null
                      }];
                    }
                  } else {
                    // Add a default variant
                    variants = [{
                      title: 'Default Title',
                      price: price,
                      compareAtPrice: compareAtPrice,
                      available: true,
                      // Add default image to the variant
                      image: images && images.length > 0 ? images[0] : null
                    }];
                  }
                }
              }
              
              // Get product type and vendor
              const productType = document.querySelector('.product-type, [itemprop="category"]')?.textContent.trim() || null;
              
              const vendor = document.querySelector('.product__vendor, .product-single__vendor, .vendor, [itemprop="brand"]')?.textContent.trim() || null;
              
              // Get breadcrumbs for categories
              const breadcrumbs = Array.from(document.querySelectorAll('.breadcrumb, .breadcrumbs, nav[aria-label="breadcrumb"] li, .breadcrumb__item, .breadcrumb-item'))
                .map(crumb => crumb.textContent.trim())
                .filter(text => text && !text.includes('Home') && !text.includes(title));
              
              // Get product handle from URL
              const url = window.location.href;
              const handle = url.split('/products/')[1]?.split('?')[0] || '';
              
              // Tags
              const tags = Array.from(document.querySelectorAll('.product-tag, .tag'))
                .map(tag => tag.textContent.trim());
                
              // Meta keywords can sometimes have tags/categories
              const metaKeywords = document.querySelector('meta[name="keywords"]')?.getAttribute('content')?.split(',').map(k => k.trim()) || [];
              
              // Determine sale status from page elements if compareAtPrice is null
              const hasSaleBadge = !!document.querySelector('.sale-badge, .on-sale, .price--on-sale, .price--sale, .product-tag--sale, .price-sale');
              
              return {
                url,
                handle,
                title,
                description,
                price,
                compareAtPrice,
                onSale: onSale || hasSaleBadge,
                images,
                variants,
                options,
                productType,
                vendor,
                breadcrumbs,
                tags: [...tags, ...metaKeywords]
              };
            } catch (error) {
              return { error: error.message, trace: error.stack };
            }
          }, productJsonData);
          
          if (productData.error) {
            console.error(`Error extracting data for ${productUrl}: ${productData.error}`);
            if (productData.trace) {
              console.error(`Stack trace: ${productData.trace}`);
            }
          } else {
            // Add to collection result
            collectionResult.products.push(productData);
            
            // Mark this product as crawled
            crawledProducts.set(productData.handle, true);
            
            // Increment counter
            collectionResult.totalProducts = collectionResult.products.length;
            
            console.log(`Successfully extracted data for ${productData.title} (${productData.handle})`);
          }
          
          // Add a small delay between requests to avoid overloading the server
          await new Promise(resolve => setTimeout(resolve, argv.delay));
          
        } catch (error) {
          console.error(`Error processing product: ${error.message}`);
        }
      }
    }
    
    return collectionResult;
  } catch (error) {
    console.error(`Error crawling collection ${collection.handle}: ${error.message}`);
    return {
      handle: collection.handle,
      url: collection.url,
      error: error.message,
      products: []
    };
  }
}

/**
 * Main function to run the crawler
 */
async function crawlCollectionsFromSitemap() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1280,800'
    ],
    defaultViewport: { width: 1280, height: 800 }
  });
  
  try {
    const page = await browser.newPage();
    
    // Set longer timeouts
    page.setDefaultNavigationTimeout(argv.timeout);
    page.setDefaultTimeout(argv.timeout);
    
    // Set user agent to avoid being detected as a bot
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block unnecessary resources to speed up crawling
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'font' || resourceType === 'media' || 
          (resourceType === 'image' && !req.url().includes('cdn.shopify.com'))) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    console.log(`\n=== INITIALIZING CRAWLER ===`);
    
    // Parse sitemap to get collections
    let collections = await parseSitemap(argv.sitemap);
    
    if (argv['debug-collection']) {
      console.log(`Debug mode: Only crawling collection "${argv['debug-collection']}"`);
      collections = collections.filter(c => c.handle === argv['debug-collection']);
    }
    
    if (collections.length === 0) {
      console.error('No collections found in sitemap. Exiting.');
      return;
    }
    
    // Create output directory if it doesn't exist
    await fs.ensureDir(argv['output-dir']);
    
    // Save all collections metadata
    const collectionsData = {
      totalCollections: collections.length,
      collections: collections.map(c => ({
        handle: c.handle,
        url: c.url,
        lastmod: c.lastmod,
        image: c.image ? c.image.url : null
      }))
    };
    
    await saveToJson(collectionsData, path.join(argv['output-dir'], 'collections_metadata.json'));
    
    // Crawl each collection
    console.log(`\n=== CRAWLING ${collections.length} COLLECTIONS ===`);
    
    for (const [index, collection] of collections.entries()) {
      console.log(`\nProcessing collection ${index + 1}/${collections.length}: ${collection.handle}`);
      
      // Skip collections without a handle
      if (!collection.handle) {
        console.log(`Skipping collection with no handle: ${collection.url}`);
        continue;
      }
      
      try {
        // Crawl collection products
        const collectionData = await crawlCollection(page, collection);
        
        // Output file path for this collection
        const outputFile = path.join(argv['output-dir'], `${collection.handle}.json`);
        
        // Save collection data to file
        await saveToJson(collectionData, outputFile);
        
        console.log(`Saved ${collectionData.products.length} products for collection "${collection.handle}" to ${outputFile}`);
      } catch (error) {
        console.error(`Error processing collection ${collection.handle}: ${error.message}`);
      }
      
      // Small delay between collections
      await new Promise(resolve => setTimeout(resolve, argv.delay * 2));
    }
    
    console.log(`\n=== CRAWLING COMPLETED ===`);
    
  } catch (error) {
    console.error('Crawling failed:', error);
  } finally {
    await browser.close();
  }
}

// Run the crawler
crawlCollectionsFromSitemap().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 