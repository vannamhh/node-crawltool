import fs from 'fs-extra';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    description: 'Input JSON file with crawled products',
    type: 'string',
    default: 'shopify_products.json'
  })
  .option('output', {
    alias: 'o',
    description: 'Output directory for processed data',
    type: 'string',
    default: 'processed_data'
  })
  .option('format', {
    alias: 'f',
    description: 'Output format (json, csv)',
    type: 'string',
    default: 'json'
  })
  .help()
  .alias('help', 'h')
  .argv;

/**
 * Process and analyze crawled Shopify product data
 */
async function processProductData() {
  try {
    console.log(`\n=== PROCESSING PRODUCT DATA ===`);
    console.log(`Loading data from: ${argv.input}`);
    
    // Ensure input file exists
    if (!await fs.pathExists(argv.input)) {
      throw new Error(`Input file not found: ${argv.input}`);
    }
    
    // Load the crawled data
    const rawData = await fs.readJSON(argv.input);
    
    if (!rawData.products || !Array.isArray(rawData.products) || rawData.products.length === 0) {
      throw new Error('No products found in the input file');
    }
    
    console.log(`Found ${rawData.products.length} products to process`);
    
    // Create output directory if it doesn't exist
    await fs.ensureDir(argv.output);
    
    // Generate stats
    const stats = await generateStats(rawData);
    
    // Write stats to file
    await fs.writeJSON(path.join(argv.output, 'stats.json'), stats, { spaces: 2 });
    console.log(`Stats written to ${path.join(argv.output, 'stats.json')}`);
    
    // Generate collection-specific data
    await generateCollectionData(rawData);
    
    // Generate categorized product lists
    await generateCategorizedProducts(rawData);
    
    // Generate price range data
    await generatePriceRangeData(rawData);
    
    console.log(`\n=== PROCESSING COMPLETED ===`);
    console.log(`Output files written to directory: ${argv.output}`);
    
  } catch (error) {
    console.error(`Error processing data: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Generate statistics about the product data
 */
async function generateStats(rawData) {
  console.log('Generating product statistics...');
  
  const products = rawData.products;
  const stats = {
    totalProducts: products.length,
    totalCollections: rawData.collections ? rawData.collections.length : 0,
    crawledCollections: rawData.collections ? rawData.collections.filter(c => c.crawled).length : 0,
    productTypes: {},
    vendors: {},
    priceStats: {
      min: null,
      max: null,
      avg: null,
      median: null,
      ranges: {
        'Under $10': 0,
        '$10-$20': 0,
        '$20-$50': 0,
        '$50-$100': 0,
        'Over $100': 0
      }
    },
    hasImages: 0,
    hasVariants: 0,
    onSale: 0,
    collectionsWithMostProducts: [],
    popularTags: {}
  };
  
  // Price calculations
  let validPrices = [];
  
  // Process each product
  for (const product of products) {
    // Count product types
    if (product.productType) {
      stats.productTypes[product.productType] = (stats.productTypes[product.productType] || 0) + 1;
    }
    
    // Count vendors
    if (product.vendor) {
      stats.vendors[product.vendor] = (stats.vendors[product.vendor] || 0) + 1;
    }
    
    // Price stats
    if (product.price && !isNaN(product.price)) {
      validPrices.push(product.price);
      
      // Categorize by price range
      if (product.price < 10) {
        stats.priceStats.ranges['Under $10']++;
      } else if (product.price < 20) {
        stats.priceStats.ranges['$10-$20']++;
      } else if (product.price < 50) {
        stats.priceStats.ranges['$20-$50']++;
      } else if (product.price < 100) {
        stats.priceStats.ranges['$50-$100']++;
      } else {
        stats.priceStats.ranges['Over $100']++;
      }
    }
    
    // Image stats
    if (product.images && product.images.length > 0) {
      stats.hasImages++;
    }
    
    // Variant stats
    if (product.variants && product.variants.length > 1) {
      stats.hasVariants++;
    }
    
    // Sale stats
    if (product.onSale) {
      stats.onSale++;
    }
    
    // Tag stats
    if (product.tags && Array.isArray(product.tags)) {
      product.tags.forEach(tag => {
        if (tag) {
          stats.popularTags[tag] = (stats.popularTags[tag] || 0) + 1;
        }
      });
    }
  }
  
  // Finalize price stats
  if (validPrices.length > 0) {
    // Sort for median calculation
    validPrices.sort((a, b) => a - b);
    
    stats.priceStats.min = Math.min(...validPrices);
    stats.priceStats.max = Math.max(...validPrices);
    stats.priceStats.avg = validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length;
    
    // Calculate median
    const middle = Math.floor(validPrices.length / 2);
    stats.priceStats.median = validPrices.length % 2 === 0
      ? (validPrices[middle - 1] + validPrices[middle]) / 2
      : validPrices[middle];
  }
  
  // Get collections with most products
  if (rawData.collections && rawData.collections.length > 0) {
    stats.collectionsWithMostProducts = [...rawData.collections]
      .filter(c => c.productCount > 0)
      .sort((a, b) => b.productCount - a.productCount)
      .slice(0, 10)
      .map(c => ({
        title: c.title,
        productCount: c.productCount,
        url: c.url
      }));
  }
  
  // Get most popular tags
  stats.popularTags = Object.entries(stats.popularTags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .reduce((obj, [tag, count]) => {
      obj[tag] = count;
      return obj;
    }, {});
  
  return stats;
}

/**
 * Generate data grouped by collection
 */
async function generateCollectionData(rawData) {
  console.log('Generating collection-specific data...');
  
  const collections = {};
  
  // Map products to collections
  for (const product of rawData.products) {
    if (product.categories && Array.isArray(product.categories)) {
      for (const category of product.categories) {
        if (!collections[category]) {
          collections[category] = {
            title: category,
            products: [],
            productCount: 0,
            totalPrice: 0,
            avgPrice: 0,
            priceRange: { min: null, max: null }
          };
        }
        
        collections[category].products.push({
          handle: product.handle,
          title: product.title,
          price: product.price,
          compareAtPrice: product.compareAtPrice,
          onSale: product.onSale,
          url: product.url,
          images: product.images ? product.images.slice(0, 1) : []
        });
        
        collections[category].productCount++;
        
        if (product.price && !isNaN(product.price)) {
          collections[category].totalPrice += product.price;
          
          // Update min/max prices
          if (collections[category].priceRange.min === null || product.price < collections[category].priceRange.min) {
            collections[category].priceRange.min = product.price;
          }
          
          if (collections[category].priceRange.max === null || product.price > collections[category].priceRange.max) {
            collections[category].priceRange.max = product.price;
          }
        }
      }
    }
  }
  
  // Calculate averages and clean up data
  for (const category in collections) {
    if (collections[category].productCount > 0 && collections[category].totalPrice > 0) {
      collections[category].avgPrice = collections[category].totalPrice / collections[category].productCount;
    }
    
    // Remove totalPrice as it's an intermediate calculation
    delete collections[category].totalPrice;
  }
  
  // Save collection data
  await fs.writeJSON(path.join(argv.output, 'collections_data.json'), collections, { spaces: 2 });
  console.log(`Collection data written to ${path.join(argv.output, 'collections_data.json')}`);
}

/**
 * Generate lists of products categorized by various criteria
 */
async function generateCategorizedProducts(rawData) {
  console.log('Generating categorized product lists...');
  
  const categorized = {
    onSale: [],
    bestValue: [],
    byType: {},
    byVendor: {}
  };
  
  // Process products
  for (const product of rawData.products) {
    // On sale products
    if (product.onSale && product.compareAtPrice > product.price) {
      const discount = ((product.compareAtPrice - product.price) / product.compareAtPrice) * 100;
      
      categorized.onSale.push({
        handle: product.handle,
        title: product.title,
        price: product.price,
        compareAtPrice: product.compareAtPrice,
        discountPercent: discount,
        url: product.url,
        image: product.images && product.images.length > 0 ? product.images[0] : null
      });
    }
    
    // Group by product type
    if (product.productType) {
      if (!categorized.byType[product.productType]) {
        categorized.byType[product.productType] = [];
      }
      
      categorized.byType[product.productType].push({
        handle: product.handle,
        title: product.title,
        price: product.price,
        url: product.url,
        image: product.images && product.images.length > 0 ? product.images[0] : null
      });
    }
    
    // Group by vendor
    if (product.vendor) {
      if (!categorized.byVendor[product.vendor]) {
        categorized.byVendor[product.vendor] = [];
      }
      
      categorized.byVendor[product.vendor].push({
        handle: product.handle,
        title: product.title,
        price: product.price,
        url: product.url,
        image: product.images && product.images.length > 0 ? product.images[0] : null
      });
    }
  }
  
  // Sort on sale products by discount percentage
  categorized.onSale.sort((a, b) => b.discountPercent - a.discountPercent);
  
  // Calculate best value items (using a simple price/features ratio if possible)
  // For this example, we'll just use on-sale items with highest discount
  categorized.bestValue = categorized.onSale.slice(0, 10);
  
  // Save categorized products
  await fs.writeJSON(path.join(argv.output, 'categorized_products.json'), categorized, { spaces: 2 });
  console.log(`Categorized product lists written to ${path.join(argv.output, 'categorized_products.json')}`);
}

/**
 * Generate data about products grouped by price range
 */
async function generatePriceRangeData(rawData) {
  console.log('Generating price range data...');
  
  // Define price ranges
  const priceRanges = {
    'Under $10': { range: [0, 9.99], products: [] },
    '$10-$20': { range: [10, 19.99], products: [] },
    '$20-$50': { range: [20, 49.99], products: [] },
    '$50-$100': { range: [50, 99.99], products: [] },
    'Over $100': { range: [100, Infinity], products: [] }
  };
  
  // Group products by price range
  for (const product of rawData.products) {
    if (product.price === null || isNaN(product.price)) {
      continue;
    }
    
    const price = product.price;
    
    // Find the appropriate price range
    for (const [rangeName, rangeData] of Object.entries(priceRanges)) {
      const [min, max] = rangeData.range;
      
      if (price >= min && price <= max) {
        priceRanges[rangeName].products.push({
          handle: product.handle,
          title: product.title,
          price: price,
          url: product.url,
          image: product.images && product.images.length > 0 ? product.images[0] : null
        });
        break;
      }
    }
  }
  
  // Save price range data
  await fs.writeJSON(path.join(argv.output, 'price_ranges.json'), priceRanges, { spaces: 2 });
  console.log(`Price range data written to ${path.join(argv.output, 'price_ranges.json')}`);
}

// Start processing
processProductData().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 