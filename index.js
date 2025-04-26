import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('url', {
    alias: 'u',
    description: 'Shopify store URL',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    description: 'Output JSON file path',
    type: 'string',
    default: 'shopify_products.json'
  })
  .option('pages', {
    alias: 'p',
    description: 'Maximum pages per collection to crawl (0 for all pages)',
    type: 'number',
    default: 0
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
  .option('save-interval', {
    description: 'Save progress after crawling this many products',
    type: 'number',
    default: 20
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
 * Function to save crawling progress
 */
async function saveProgress(data, filename) {
  try {
    await fs.ensureFile(filename);
    await fs.writeJSON(filename, data, { spaces: 2 });
    console.log(`Progress saved to ${filename}`);
  } catch (error) {
    console.error(`Error saving progress: ${error.message}`);
  }
}

// URL utilities
function makeAbsoluteUrl(url, baseUrl) {
  if (!url) return null;
  return url.startsWith('/') ? new URL(url, baseUrl).href : url;
}

// Image processing
function getHighResImage(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.includes('cdn.shopify.com')) {
    return imageUrl.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
  }
  return imageUrl;
}

// Price formatting
function normalizePrice(price) {
  if (!price) return null;
  return price > 10000 ? price / 100 : price;
}

// DOM utilities
async function queryDomWithSelectors(page, selectors, attribute = 'textContent', transform = (x) => x.trim()) {
  return page.evaluate((selectors, attribute, transform) => {
    for (const selector of selectors.split(',')) {
      const element = document.querySelector(selector.trim());
      if (element) {
        const value = element[attribute];
        return transform ? transform(value) : value;
      }
    }
    return null;
  }, selectors, attribute, transform);
}

/**
 * Step-by-step crawler for Shopify products
 */
async function crawlShopifyProducts() {
  const browser = await puppeteer.launch({
    headless: "new",
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
    
    console.log(`\n=== STEP 1: INITIALIZING CRAWLER ===`);
    console.log(`Target store: ${argv.url}`);
    const baseUrl = argv.url.endsWith('/') ? argv.url : `${argv.url}/`;
    
    // Initialize result data structure
    const result = {
      store: argv.url,
      crawledAt: new Date().toISOString(),
      collections: [],
      products: [],
      totalProducts: 0
    };
    
    // Map to keep track of what products we've already crawled (to avoid duplicates)
    const crawledProducts = new Map();
    
    // STEP 1: Crawl all collections
    console.log(`\n=== STEP 2: CRAWLING COLLECTIONS ===`);
    
    // Navigate to collections page
    const collectionsUrl = `${baseUrl}collections`;
    console.log(`Navigating to collections list: ${collectionsUrl}`);
    
    try {
      await safeNavigate(page, collectionsUrl);
      console.log('Successfully loaded collections page');
      
      // Get all collection links
      const collectionLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/collections/"]'))
          .filter(link => {
            const href = link.getAttribute('href');
            // Filter out links to specific products within collections
            return href.includes('/collections/') && !href.includes('/products/');
          })
          .map(link => ({
            url: link.href,
            title: link.textContent.trim() || link.getAttribute('title') || 'Unknown Collection'
          }))
          .filter(item => item.title && item.title !== 'Unknown Collection');
        
        // Remove duplicates
        return Array.from(new Map(links.map(item => [item.url, item])).values());
      });
      
      console.log(`Found ${collectionLinks.length} collections`);
      
      // Add "All" collection if it's not already included
      let hasAllCollection = false;
      for (const collection of collectionLinks) {
        if (collection.url.includes('/collections/all')) {
          hasAllCollection = true;
          break;
        }
      }
      
      if (!hasAllCollection) {
        collectionLinks.push({
          url: `${baseUrl}collections/all`,
          title: 'All Products'
        });
      }
      
      // Save the collection list to result
      result.collections = collectionLinks.map(collection => ({
        title: collection.title,
        url: collection.url,
        productCount: 0
      }));
      
      // STEP 2: For each collection, crawl all products
      console.log(`\n=== STEP 3: CRAWLING PRODUCTS BY COLLECTION ===`);
      
      // Process each collection
      for (const [colIndex, collection] of collectionLinks.entries()) {
        // Skip the "all" collection until the end if we have other collections
        if (collection.url.includes('/collections/all') && collectionLinks.length > 1 && colIndex !== collectionLinks.length - 1) {
          console.log(`Skipping "All Products" collection for now - will process at the end`);
          continue;
        }
        
        if (collection.url.includes('/collections/frontpage') && collectionLinks.length > 1) {
          console.log(`Skipping "Featured Products" collection - will process others first`);
          continue;
        }
        
        console.log(`\nCollection ${colIndex + 1}/${collectionLinks.length}: "${collection.title}" (${collection.url})`);
        
        try {
          // Navigate to collection page
          await safeNavigate(page, collection.url);
          console.log(`Successfully loaded collection page`);
          
          // Get total pages in this collection
          let totalPages = 1;
          try {
            const paginationSelector = '.pagination, .pagination-wrapper, nav[role="navigation"]';
            const hasPagination = await page.$(paginationSelector);
            
            if (hasPagination) {
              const pageNumbersText = await page.evaluate(() => {
                const paginationEl = document.querySelector('.pagination, .pagination-wrapper, nav[role="navigation"]');
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
          } catch (err) {
            console.log('No pagination found, assuming single page');
          }
          
          console.log(`Found ${totalPages} pages in this collection`);
          
          // Set max pages to crawl
          const maxPages = argv.pages > 0 ? Math.min(argv.pages, totalPages) : totalPages;
          let collectionProductCount = 0;
          
          // Crawl each page in this collection
          for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
            console.log(`Processing page ${currentPage}/${maxPages} of collection "${collection.title}"`);
            
            if (currentPage > 1) {
              const nextPageUrl = `${collection.url}?page=${currentPage}`;
              try {
                await safeNavigate(page, nextPageUrl);
              } catch (error) {
                console.error(`Error navigating to page ${currentPage}: ${error.message}`);
                // Skip to next page on error
                continue;
              }
            }
            
            // Get all product links on this page
            const productLinks = await page.evaluate(() => {
              return Array.from(document.querySelectorAll('a.product-card, a[href*="/products/"]'))
                .filter(link => link.href && link.href.includes('/products/'))
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
                    
                    // Set default compareAtPrice for variants if missing but item appears to be on sale
                    if (hasSaleBadge && variants.length > 0) {
                      variants.forEach(variant => {
                        // Only set compareAtPrice if it's null and we have a price
                        if (variant.compareAtPrice === null && variant.price) {
                          // Estimate compareAtPrice as 15% higher than current price as a fallback
                          variant.compareAtPrice = Math.round((variant.price * 1.15) * 100) / 100;
                          variant.estimatedComparePrice = true; // Flag this as an estimated value
                        }
                      });
                    }
                    
                    // Try to extract option_value -> image mapping from product JSON data
                    try {
                      // Find scripts containing productData with variant images
                      const shopifyProductJson = document.querySelector('#ProductJson-product-template, #ProductJson-template, [data-product-json]');
                      if (shopifyProductJson) {
                        const productData = JSON.parse(shopifyProductJson.textContent);
                        // Create direct variant ID to image mapping
                        if (productData && productData.images && productData.variants) {
                          const variantIdToImageMap = new Map();
                          
                          // Some shops store variant_ids directly on images
                          productData.images.forEach(image => {
                            if (image.variant_ids && Array.isArray(image.variant_ids)) {
                              image.variant_ids.forEach(variantId => {
                                let imageUrl = typeof image === 'string' ? image : image.src;
                                // Make relative URLs absolute
                                if (!imageUrl.startsWith('http')) {
                                  imageUrl = new URL(imageUrl, window.location.origin).href;
                                }
                                // For Shopify CDN images, try to get high resolution
                                if (imageUrl.includes('cdn.shopify.com')) {
                                  imageUrl = imageUrl.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                }
                                variantIdToImageMap.set(variantId.toString(), imageUrl);
                              });
                            }
                          });
                          
                          // Apply these images to variants
                          if (variantIdToImageMap.size > 0) {
                            variants.forEach(variant => {
                              if (variant.id && variantIdToImageMap.has(variant.id.toString())) {
                                variant.image = variantIdToImageMap.get(variant.id.toString());
                              }
                            });
                          }
                        }
                      }
                    } catch (e) {
                      // Ignore errors in JSON parsing
                    }
                    
                    // Extract Shopify's variant-specific image data
                    try {
                      // Look for scripts with variant featured_image data
                      const scripts = document.querySelectorAll('script:not([src])');
                      for (const script of scripts) {
                        const content = script.textContent;
                        
                        // Look for variant selectors that change images
                        if (content.includes('.variants =') || content.includes('product.variants =')) {
                          // Try to extract variant data that maps to images
                          const variantMappingRegex = /(\w+)\.variants\s*=\s*(\{[^;]*\}|\[[^;]*\])/g;
                          const variantMatch = variantMappingRegex.exec(content);
                          
                          if (variantMatch) {
                            // Try to find image switcher code
                            const imageSwitcherRegex = /(\w+)\.variantImage\s*=\s*function\s*\([^)]*\)\s*\{([^}]*)\}/g;
                            const imageSwitcherMatch = imageSwitcherRegex.exec(content);
                            
                            if (imageSwitcherMatch) {
                              // Found code that switches images based on variants
                              // This indicates the theme has variant-specific images
                              console.log("Found variant image switcher code");
                            }
                          }
                        }
                        
                        // Look for variant image map in newer Shopify themes
                        if (content.includes('variantImages') || content.includes('variant_images') || 
                            content.includes('variantImageMap') || content.includes('optionImageMap')) {
                          const variantImageMapRegex = /(variantImages|variant_images|variantImageMap|optionImageMap)\s*=\s*(\{[^;]*\})/g;
                          const mapMatch = variantImageMapRegex.exec(content);
                          
                          if (mapMatch) {
                            // Found a direct map of variant IDs to images
                            console.log("Found variant image map");
                          }
                        }
                      }
                    } catch (e) {
                      // Ignore errors in regex or mapping
                      console.error("Error parsing variant image data:", e);
                    }
                    
                    // Look for variant image selectors common in many Shopify themes
                    const variantImageSelectors = document.querySelectorAll('.product-single__thumbnail, .product-gallery__thumbnail, .product-thumbnails__item, [data-image-id], [data-variant-id], [data-variant-image], [data-image], [data-zoom-id], [data-media-id]');
                    
                    if (variantImageSelectors.length > 0) {
                      // Create a map of variant option values to image URLs
                      const variantOptionToImageMap = new Map();
                      const variantIdToImageMap = new Map();
                      const skuToImageMap = new Map();
                      
                      variantImageSelectors.forEach(selector => {
                        // Try to get variant option value or ID from the selector
                        const variantId = selector.getAttribute('data-variant-id') || 
                                        selector.getAttribute('data-variant') || 
                                        selector.getAttribute('data-value-id');
                        
                        const imageId = selector.getAttribute('data-image-id') || 
                                      selector.getAttribute('data-zoom-id') || 
                                      selector.getAttribute('data-media-id');
                                      
                        const sku = selector.getAttribute('data-sku') || 
                                  selector.getAttribute('data-variant-sku');
                                  
                        const optionValue = selector.getAttribute('data-option-value') || 
                                          selector.getAttribute('data-value') || 
                                          selector.getAttribute('title') || 
                                          selector.getAttribute('alt') ||
                                          selector.textContent.trim();
                        
                        // Get the image URL from the selector
                        let imageUrl = null;
                        // Check for direct image URL attribute first
                        imageUrl = selector.getAttribute('data-image') || 
                                 selector.getAttribute('data-src') || 
                                 selector.getAttribute('data-zoom-image') || 
                                 selector.getAttribute('data-large-img') ||
                                 selector.getAttribute('data-full-resolution') ||
                                 selector.getAttribute('href');
                        
                        // If no direct attribute, check for img child
                        if (!imageUrl) {
                          const img = selector.querySelector('img');
                          if (img) {
                            imageUrl = img.getAttribute('data-src') || 
                                     img.getAttribute('data-zoom-image') || 
                                     img.getAttribute('data-full-resolution') ||
                                     img.getAttribute('src');
                          }
                        }
                        
                        // Check for background image
                        if (!imageUrl && selector.style && selector.style.backgroundImage) {
                          const bgMatch = selector.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                          if (bgMatch && bgMatch[1]) {
                            imageUrl = bgMatch[1];
                          }
                        }
                        
                        // If we have both a variant identifier and an image URL, add to map
                        if (imageUrl) {
                          // Make relative URLs absolute
                          if (!imageUrl.startsWith('http')) {
                            imageUrl = new URL(imageUrl, window.location.origin).href;
                          }
                          
                          // For Shopify CDN images, try to get high resolution
                          if (imageUrl.includes('cdn.shopify.com')) {
                            imageUrl = imageUrl.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                          }
                          
                          // Add to the appropriate map
                          if (variantId) {
                            variantIdToImageMap.set(variantId, imageUrl);
                          }
                          if (sku) {
                            skuToImageMap.set(sku.toLowerCase(), imageUrl);
                          }
                          if (optionValue) {
                            variantOptionToImageMap.set(optionValue.toLowerCase(), imageUrl);
                          }
                        }
                      });
                      
                      // Also look for data-option-value attributes on thumbnail containers
                      document.querySelectorAll('[data-option-value]').forEach(el => {
                        const optionValue = el.getAttribute('data-option-value');
                        if (!optionValue) return;
                        
                        // Find image associated with this option
                        const img = el.querySelector('img');
                        if (img && img.src) {
                          let imageUrl = img.src;
                          
                          // Make relative URLs absolute
                          if (!imageUrl.startsWith('http')) {
                            imageUrl = new URL(imageUrl, window.location.origin).href;
                          }
                          
                          // For Shopify CDN images, try to get high resolution
                          if (imageUrl.includes('cdn.shopify.com')) {
                            imageUrl = imageUrl.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                          }
                          
                          variantOptionToImageMap.set(optionValue.toLowerCase(), imageUrl);
                        }
                      });
                      
                      // Apply the mapped images to variants - prioritize more specific matches
                      variants.forEach(variant => {
                        // Only update if we don't already have an image for this variant
                        if (variant.image && !variant.image.includes('/no-image-available')) {
                          return;
                        }
                        
                        // 1. Try to match by variant ID (most specific)
                        if (variant.id && variantIdToImageMap.has(variant.id.toString())) {
                          variant.image = variantIdToImageMap.get(variant.id.toString());
                          return;
                        }
                        
                        // 2. Try to match by SKU
                        if (variant.sku && skuToImageMap.has(variant.sku.toLowerCase())) {
                          variant.image = skuToImageMap.get(variant.sku.toLowerCase());
                          return;
                        }
                        
                        // 3. Try to match by option values
                        const optionValues = [
                          variant.option1, 
                          variant.option2, 
                          variant.option3
                        ].filter(Boolean).map(val => val.toLowerCase());
                        
                        for (const optionValue of optionValues) {
                          if (variantOptionToImageMap.has(optionValue)) {
                            variant.image = variantOptionToImageMap.get(optionValue);
                            return;
                          }
                        }
                        
                        // 4. If title has unique information, try to match with that
                        if (variant.title) {
                          const titleLower = variant.title.toLowerCase();
                          // Check if any option value from the map is contained in the title
                          for (const [optVal, imgUrl] of variantOptionToImageMap.entries()) {
                            if (titleLower.includes(optVal)) {
                              variant.image = imgUrl;
                              return;
                            }
                          }
                        }
                      });
                    }
                    
                    // Assign different product images to variants based on index if all else fails
                    // This ensures at least some variation in images between variants
                    if (images.length > 1 && variants.length > 1) {
                      let allVariantsHaveSameImage = true;
                      const firstImage = variants[0].image;
                      
                      for (let i = 1; i < variants.length; i++) {
                        if (variants[i].image !== firstImage) {
                          allVariantsHaveSameImage = false;
                          break;
                        }
                      }
                      
                      // If all variants have the same image, distribute available product images
                      if (allVariantsHaveSameImage) {
                        for (let i = 0; i < variants.length; i++) {
                          // Ensure we don't go out of bounds with images array
                          const imageIndex = i % images.length;
                          variants[i].image = images[imageIndex];
                        }
                      }
                    }
                    
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
                  // Add collection information
                  if (!productData.categories) {
                    productData.categories = [];
                  }
                  
                  if (!productData.categories.includes(collection.title)) {
                    productData.categories.push(collection.title);
                  }
                  
                  // Add product to results
                  result.products.push(productData);
                  
                  // Mark this product as crawled
                  crawledProducts.set(productData.handle, true);
                  
                  // Increment counters
                  collectionProductCount++;
                  result.totalProducts = result.products.length;
                  
                  console.log(`Successfully extracted data for ${productData.title} (${productData.handle})`);
                  
                  // Save progress periodically
                  if (result.products.length % argv['save-interval'] === 0) {
                    await saveProgress(result, argv.output);
                  }
                }
                
                // Add a small delay between requests to avoid overloading the server
                await new Promise(resolve => setTimeout(resolve, argv.delay));
                
              } catch (error) {
                console.error(`Error processing product: ${error.message}`);
              }
            }
          }
          
          // Update collection product count
          const collectionIndex = result.collections.findIndex(c => c.url === collection.url);
          if (collectionIndex !== -1) {
            result.collections[collectionIndex].productCount = collectionProductCount;
          }
          
          console.log(`Completed collection "${collection.title}" - found ${collectionProductCount} products`);
          
          // Save progress after each collection
          await saveProgress(result, argv.output);
          
        } catch (error) {
          console.error(`Error processing collection ${collection.title}: ${error.message}`);
        }
      }
      
      console.log(`\n=== STEP 4: CRAWLING COMPLETED ===`);
      console.log(`Total collections: ${result.collections.length}`);
      console.log(`Total products: ${result.products.length}`);
      
      // Final save of all data
      await saveProgress(result, argv.output);
      
    } catch (error) {
      console.error(`Failed to crawl collections: ${error.message}`);
      throw error;
    }
    
  } catch (error) {
    console.error('Crawling failed:', error);
  } finally {
    await browser.close();
  }
}

crawlShopifyProducts().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 