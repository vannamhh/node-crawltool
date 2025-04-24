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
                
                // Extract product details
                const productData = await page.evaluate(() => {
                  // Function to parse money values
                  const parseMoney = (moneyString) => {
                    if (!moneyString) return null;
                    // Remove currency symbols and whitespace, handle different formats
                    return parseFloat(moneyString.replace(/[^\d,.]/g, '')
                      .replace(/,(\d{2})$/, '.$1')  // Handle comma as decimal separator in some locales
                      .replace(/,/g, '')); // Remove thousands separators
                  };
                  
                  try {
                    // Collect all script tags for later use
                    const scriptTags = Array.from(document.querySelectorAll('script:not([src])'));
                    
                    // Basic product info
                    const title = document.querySelector('h1, .product-title, .product__title')?.textContent.trim();
                    
                    // Get full description - try different selectors used by Shopify themes
                    const description = document.querySelector('.product__description')?.innerHTML.trim() || 
                                       document.querySelector('.product-single__description')?.innerHTML.trim() || 
                                       document.querySelector('[data-product-description]')?.innerHTML.trim() ||
                                       document.querySelector('.product-description')?.innerHTML.trim() ||
                                       document.querySelector('#product-description')?.innerHTML.trim() ||
                                       document.querySelector('.description')?.innerHTML.trim() ||
                                       document.querySelector('[itemprop="description"]')?.innerHTML.trim();
                    
                    // Price information
                    let price = null;
                    let compareAtPrice = null;
                    let onSale = false;
                    
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
                    const images = [];
                    
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
                      
                      // If still no images, look for image URLs in JSON data in script tags
                      if (images.length === 0) {
                        for (const script of scriptTags) {
                          try {
                            const content = script.textContent || script.innerText;
                            // Look for image URLs in various JSON formats
                            if (content.includes('"images"') || content.includes('"image"')) {
                              // Find image URLs using regex
                              const urlRegex = /"(?:(?:https?|ftp):\/\/|\/\/)(?:\S+)(?:png|jpe?g|gif|webp)"/gi;
                              const matches = content.match(urlRegex);
                              
                              if (matches && matches.length > 0) {
                                matches.forEach(url => {
                                  // Remove quotes
                                  const cleanUrl = url.replace(/"/g, '');
                                  if (!images.includes(cleanUrl)) {
                                    images.push(cleanUrl);
                                  }
                                });
                                
                                if (images.length > 0) {
                                  break;
                                }
                              }
                            }
                          } catch (e) {
                            // Ignore errors and continue
                          }
                        }
                      }
                    }
                    
                    // Extract variants
                    let variants = [];
                    let options = [];
                    
                    // Try to find variants in JSON
                    let variantsFromJson = false;
                    
                    for (const script of scriptTags) {
                      const content = script.textContent || script.innerText;
                      
                      if (content.includes('var meta =') || content.includes('window.ShopifyAnalytics.meta =')) {
                        try {
                          // Extract meta JSON (new format)
                          const metaMatch = content.match(/var meta\s*=\s*([^;]*);/) || 
                                          content.match(/window\.ShopifyAnalytics\.meta\s*=\s*([^;]*);/);
                          
                          if (metaMatch && metaMatch[1]) {
                            const meta = JSON.parse(metaMatch[1]);
                            if (meta.product && meta.product.variants) {
                              variants = meta.product.variants.map(v => {
                                // Try to get variant image if available
                                let variantImage = null;
                                
                                // Method 1: Direct featured_image in variant
                                if (v.featured_image && v.featured_image.src) {
                                  variantImage = v.featured_image.src;
                                  
                                  // Make relative URLs absolute
                                  if (!variantImage.startsWith('http')) {
                                    variantImage = new URL(variantImage, window.location.origin).href;
                                  }
                                  
                                  // For Shopify CDN images, try to get high resolution
                                  if (variantImage.includes('cdn.shopify.com')) {
                                    variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                  }
                                }
                                
                                // Method 2: Try to find image by variant option values in product images
                                if (!variantImage && meta.product.images && meta.product.images.length > 0) {
                                  // Get variant option values (e.g. "Blue", "Small", etc.)
                                  const optionValues = [v.option1, v.option2, v.option3].filter(Boolean).map(val => val.toLowerCase());
                                  
                                  // Look for images with alt text or file name containing any of the variant options
                                  const matchingImage = meta.product.images.find(img => {
                                    // Check filename for option value matches
                                    if (img.src) {
                                      const filename = img.src.split('/').pop().toLowerCase();
                                      if (optionValues.some(val => filename.includes(val))) {
                                        return true;
                                      }
                                    }
                                    
                                    // Check alt text for option value matches
                                    if (img.alt) {
                                      const altText = img.alt.toLowerCase();
                                      if (optionValues.some(val => altText.includes(val))) {
                                        return true;
                                      }
                                    }
                                    
                                    return false;
                                  });
                                  
                                  if (matchingImage && matchingImage.src) {
                                    variantImage = matchingImage.src;
                                    
                                    // Make relative URLs absolute
                                    if (!variantImage.startsWith('http')) {
                                      variantImage = new URL(variantImage, window.location.origin).href;
                                    }
                                    
                                    // For Shopify CDN images, try to get high resolution
                                    if (variantImage.includes('cdn.shopify.com')) {
                                      variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                    }
                                  }
                                }
                                
                                // Method 3: Fallback to first product image if no variant image found
                                if (!variantImage && meta.product.images && meta.product.images.length > 0) {
                                  const firstImage = meta.product.images[0];
                                  if (firstImage && (firstImage.src || typeof firstImage === 'string')) {
                                    variantImage = typeof firstImage === 'string' ? firstImage : firstImage.src;
                                    
                                    // Make relative URLs absolute
                                    if (!variantImage.startsWith('http')) {
                                      variantImage = new URL(variantImage, window.location.origin).href;
                                    }
                                    
                                    // For Shopify CDN images, try to get high resolution
                                    if (variantImage.includes('cdn.shopify.com')) {
                                      variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                    }
                                  }
                                }
                                
                                return {
                                  id: v.id,
                                  title: v.name || v.title,
                                  price: v.price / 100, // Shopify stores prices in cents
                                  compareAtPrice: v.compare_at_price ? v.compare_at_price / 100 : null,
                                  sku: v.sku,
                                  available: v.available || v.inventory_quantity > 0,
                                  options: v.options || [v.option1, v.option2, v.option3].filter(Boolean),
                                  image: variantImage || (images && images.length > 0 ? images[0] : null)
                                };
                              });
                              
                              if (meta.product.options) {
                                options = meta.product.options.map(o => ({
                                  name: o.name,
                                  values: o.values
                                }));
                              }
                              
                              // Also check for product images at the product level
                              if (meta.product.images && meta.product.images.length > 0 && images.length === 0) {
                                meta.product.images.forEach(img => {
                                  if (typeof img === 'string') {
                                    // Ensure it's an absolute URL
                                    const fullUrl = new URL(img, window.location.origin).href;
                                    images.push(fullUrl);
                                  } else if (img.src) {
                                    // Ensure it's an absolute URL
                                    const fullUrl = new URL(img.src, window.location.origin).href;
                                    images.push(fullUrl);
                                  }
                                });
                              }
                              
                              variantsFromJson = true;
                              break;
                            }
                          }
                        } catch (e) {
                          // Continue to next method if this fails
                        }
                      }
                      
                      // Try older format
                      if (!variantsFromJson && (content.includes('Product = ') || content.includes('var product ='))) {
                        try {
                          // Extract product JSON from script tag
                          let match = content.match(/Product = (.*?);/) || 
                                    content.match(/var product = (.*?);/) ||
                                    content.match(/window\['Product'\] = (.*?);/);
                          
                          if (match && match[1]) {
                            const productJson = JSON.parse(match[1]);
                            if (productJson && productJson.variants) {
                              variants = productJson.variants.map(v => {
                                // Try to get variant image
                                let variantImage = null;
                                
                                // Method 1: Find matching image for this variant by ID
                                if (productJson.images && v.featured_image) {
                                  const featuredImageId = v.featured_image.id;
                                  // Find image with matching ID
                                  const matchingImage = productJson.images.find(img => 
                                    img.id === featuredImageId || 
                                    (img.variant_ids && img.variant_ids.includes(v.id))
                                  );
                                  
                                  if (matchingImage && matchingImage.src) {
                                    variantImage = matchingImage.src;
                                    
                                    // Make sure it's a full URL
                                    if (!variantImage.startsWith('http')) {
                                      variantImage = new URL(variantImage, window.location.origin).href;
                                    }
                                    
                                    // For Shopify CDN images, try to get high resolution
                                    if (variantImage.includes('cdn.shopify.com')) {
                                      variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                    }
                                  }
                                }
                                
                                // Method 2: Try to find image by variant option values in product images
                                if (!variantImage && productJson.images && productJson.images.length > 0) {
                                  // Get variant option values (e.g. "Blue", "Small", etc.)
                                  const optionValues = [v.option1, v.option2, v.option3].filter(Boolean).map(val => val.toLowerCase());
                                  
                                  // Look for images with alt text or file name containing any of the variant options
                                  const matchingImage = productJson.images.find(img => {
                                    // Check filename for option value matches
                                    if (img.src) {
                                      const filename = img.src.split('/').pop().toLowerCase();
                                      if (optionValues.some(val => filename.includes(val))) {
                                        return true;
                                      }
                                    }
                                    
                                    // Check alt text for option value matches
                                    if (img.alt) {
                                      const altText = img.alt.toLowerCase();
                                      if (optionValues.some(val => altText.includes(val))) {
                                        return true;
                                      }
                                    }
                                    
                                    return false;
                                  });
                                  
                                  if (matchingImage && matchingImage.src) {
                                    variantImage = matchingImage.src;
                                    
                                    // Make relative URLs absolute
                                    if (!variantImage.startsWith('http')) {
                                      variantImage = new URL(variantImage, window.location.origin).href;
                                    }
                                    
                                    // For Shopify CDN images, try to get high resolution
                                    if (variantImage.includes('cdn.shopify.com')) {
                                      variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                    }
                                  }
                                }
                                
                                // Method 3: Fallback to first product image if no variant image found
                                if (!variantImage && productJson.images && productJson.images.length > 0) {
                                  const firstImage = productJson.images[0];
                                  if (firstImage && firstImage.src) {
                                    variantImage = firstImage.src;
                                    
                                    // Make sure it's a full URL
                                    if (!variantImage.startsWith('http')) {
                                      variantImage = new URL(variantImage, window.location.origin).href;
                                    }
                                    
                                    // For Shopify CDN images, try to get high resolution
                                    if (variantImage.includes('cdn.shopify.com')) {
                                      variantImage = variantImage.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                                    }
                                  }
                                }
                                
                                return {
                                  id: v.id,
                                  title: v.title,
                                  price: v.price / 100, // Shopify stores prices in cents
                                  compareAtPrice: v.compare_at_price ? v.compare_at_price / 100 : null,
                                  sku: v.sku,
                                  available: v.available,
                                  option1: v.option1,
                                  option2: v.option2,
                                  option3: v.option3,
                                  image: variantImage || (images && images.length > 0 ? images[0] : null)
                                };
                              });
                              
                              if (productJson.options) {
                                options = productJson.options.map(o => ({
                                  name: o.name,
                                  values: o.values
                                }));
                              }
                              
                              // Also check for product images at the product level
                              if (productJson.images && productJson.images.length > 0 && images.length === 0) {
                                productJson.images.forEach(img => {
                                  if (typeof img === 'string') {
                                    // Ensure it's an absolute URL
                                    const fullUrl = new URL(img, window.location.origin).href;
                                    images.push(fullUrl);
                                  } else if (img.src) {
                                    // Ensure it's an absolute URL
                                    const fullUrl = new URL(img.src, window.location.origin).href;
                                    images.push(fullUrl);
                                  }
                                });
                              }
                              
                              variantsFromJson = true;
                              break;
                            }
                          }
                        } catch (e) {
                          // If JSON parsing fails, continue to next script tag
                        }
                      }
                    }
                    
                    // If no variants found in JSON, try to extract from DOM
                    if (!variantsFromJson) {
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
                      }
                    }
                    
                    // If still no variants, add a default variant
                    if (variants.length === 0) {
                      variants = [{
                        title: 'Default Title',
                        price: price,
                        compareAtPrice: compareAtPrice,
                        available: true,
                        // Add default image to the variant
                        image: images && images.length > 0 ? images[0] : null
                      }];
                    }
                    
                    // Final fallback check for image URLs if we still don't have any
                    if (images.length === 0) {
                      const allImages = document.querySelectorAll('img');
                      const productKeywords = ['product', 'item', 'main', 'featured', 'gallery', 'zoom'];
                      
                      allImages.forEach(img => {
                        const src = img.getAttribute('src');
                        if (!src) return;
                        
                        // Check if this looks like a product image based on URL or containing element classes
                        const isProductImage = productKeywords.some(keyword => 
                          (src.toLowerCase().includes(keyword)) || 
                          (img.className && img.className.toLowerCase().includes(keyword)) ||
                          (img.id && img.id.toLowerCase().includes(keyword))
                        );
                        
                        if (isProductImage && !src.includes('icon') && !src.includes('logo')) {
                          // Make relative URLs absolute
                          let fullSrc = src;
                          if (!fullSrc.startsWith('http')) {
                            fullSrc = new URL(fullSrc, window.location.origin).href;
                          }
                          
                          // For Shopify CDN images, try to get high resolution
                          if (fullSrc.includes('cdn.shopify.com')) {
                            fullSrc = fullSrc.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original)_/, '_2048x2048_');
                          }
                          
                          if (!images.includes(fullSrc)) {
                            images.push(fullSrc);
                          }
                        }
                      });
                    }
                    
                    // Final fallback: If still no product images, create a placeholder image
                    if (images.length === 0) {
                      // Use the store's logo or a generic image URL as ultimate fallback
                      const logoImg = document.querySelector('.site-header__logo img, .header__logo img, .logo img');
                      if (logoImg && logoImg.src) {
                        let logoSrc = logoImg.src;
                        // Make relative URLs absolute
                        if (!logoSrc.startsWith('http')) {
                          logoSrc = new URL(logoSrc, window.location.origin).href;
                        }
                        images.push(logoSrc);
                      } else {
                        // Push store URL as identifier that we couldn't find an image
                        images.push(window.location.origin + '/no-image-available');
                      }
                    }
                    
                    // Ensure absolutely no variant has a null image - final thorough check
                    const defaultImage = images && images.length > 0 ? images[0] : null;
                    variants.forEach(variant => {
                      if (!variant.image) {
                        variant.image = defaultImage;
                      }
                    });
                    
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
                });
                
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