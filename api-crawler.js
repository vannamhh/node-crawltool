import fs from 'fs-extra';
import path from 'path';
import fetch from 'node-fetch';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('store', {
    alias: 's',
    description: 'Shopify store domain (without https://)',
    type: 'string',
    demandOption: true
  })
  .option('access_token', {
    alias: 't',
    description: 'Shopify Storefront API access token',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    description: 'Output JSON file path',
    type: 'string',
    default: 'shopify_products_api.json'
  })
  .option('limit', {
    alias: 'l',
    description: 'Products per page (max 250, use 0 for all)',
    type: 'number',
    default: 50
  })
  .option('collections', {
    alias: 'c',
    description: 'Crawl products by collection (true/false)',
    type: 'boolean',
    default: true
  })
  .help()
  .alias('help', 'h')
  .argv;

// Constants
const STOREFRONT_API_VERSION = '2023-10';
const GRAPHQL_URL = `https://${argv.store}/api/${STOREFRONT_API_VERSION}/graphql.json`;

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
 * Execute a GraphQL query against the Shopify Storefront API
 */
async function executeQuery(query, variables = {}) {
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': argv.access_token
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
    }

    const data = await response.json();
    
    if (data.errors && data.errors.length > 0) {
      throw new Error(`GraphQL error: ${data.errors.map(e => e.message).join(', ')}`);
    }
    
    return data.data;
  } catch (error) {
    console.error(`Query execution failed: ${error.message}`);
    throw error;
  }
}

/**
 * Get all collections from the shop
 */
async function getCollections() {
  console.log('Fetching collections...');
  
  const collectionsQuery = `
  query GetCollections($first: Int!) {
    collections(first: $first) {
      edges {
        node {
          id
          handle
          title
          description
          descriptionHtml
          productsCount
          image {
            url
            altText
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  `;
  
  let allCollections = [];
  let hasNextPage = true;
  let cursor = null;
  
  while (hasNextPage) {
    const variables = {
      first: 250,
      after: cursor
    };
    
    try {
      const data = await executeQuery(collectionsQuery, variables);
      
      const collections = data.collections.edges.map(edge => edge.node);
      allCollections = [...allCollections, ...collections];
      
      hasNextPage = data.collections.pageInfo.hasNextPage;
      cursor = data.collections.pageInfo.endCursor;
      
      console.log(`Fetched ${collections.length} collections, total: ${allCollections.length}`);
      
      if (hasNextPage) {
        // Add a small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`Error fetching collections: ${error.message}`);
      break;
    }
  }
  
  // Filter out empty collections
  const nonEmptyCollections = allCollections.filter(collection => collection.productsCount > 0);
  
  console.log(`Found ${nonEmptyCollections.length} non-empty collections out of ${allCollections.length} total collections`);
  
  return nonEmptyCollections;
}

/**
 * Get products for a specific collection
 */
async function getProductsByCollection(collectionHandle, limit = 50) {
  console.log(`Fetching products for collection: ${collectionHandle}`);
  
  const productsByCollectionQuery = `
  query GetProductsByCollection($handle: String!, $first: Int!, $after: String) {
    collection(handle: $handle) {
      title
      products(first: $first, after: $after) {
        edges {
          node {
            id
            title
            handle
            description
            descriptionHtml
            productType
            tags
            vendor
            createdAt
            publishedAt
            updatedAt
            options {
              id
              name
              values
            }
            variants(first: 250) {
              edges {
                node {
                  id
                  title
                  quantityAvailable
                  availableForSale
                  requiresShipping
                  selectedOptions {
                    name
                    value
                  }
                  compareAtPrice {
                    amount
                    currencyCode
                  }
                  price {
                    amount
                    currencyCode
                  }
                  sku
                  image {
                    url
                    altText
                    width
                    height
                  }
                }
              }
            }
            images(first: 20) {
              edges {
                node {
                  url
                  altText
                  width
                  height
                }
              }
            }
            priceRange {
              minVariantPrice {
                amount
                currencyCode
              }
              maxVariantPrice {
                amount
                currencyCode
              }
            }
            compareAtPriceRange {
              minVariantPrice {
                amount
                currencyCode
              }
              maxVariantPrice {
                amount
                currencyCode
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
  `;
  
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  let maxProducts = limit > 0 ? limit : Infinity;
  
  while (hasNextPage && allProducts.length < maxProducts) {
    const variables = {
      handle: collectionHandle,
      first: Math.min(250, maxProducts - allProducts.length),
      after: cursor
    };
    
    try {
      const data = await executeQuery(productsByCollectionQuery, variables);
      
      if (!data.collection) {
        console.error(`Collection not found: ${collectionHandle}`);
        break;
      }
      
      const products = data.collection.products.edges.map(edge => {
        const product = edge.node;
        
        // Transform the data to match our schema
        return {
          id: product.id,
          title: product.title,
          handle: product.handle,
          url: `https://${argv.store}/products/${product.handle}`,
          description: product.description,
          descriptionHtml: product.descriptionHtml,
          productType: product.productType,
          vendor: product.vendor,
          tags: product.tags,
          options: product.options,
          createdAt: product.createdAt,
          publishedAt: product.publishedAt,
          updatedAt: product.updatedAt,
          price: parseFloat(product.priceRange.minVariantPrice.amount),
          compareAtPrice: product.compareAtPriceRange.maxVariantPrice.amount !== '0.0' 
            ? parseFloat(product.compareAtPriceRange.maxVariantPrice.amount)
            : null,
          onSale: product.compareAtPriceRange.maxVariantPrice.amount !== '0.0' &&
                 parseFloat(product.compareAtPriceRange.maxVariantPrice.amount) > parseFloat(product.priceRange.minVariantPrice.amount),
          variants: product.variants.edges.map(variantEdge => {
            const variant = variantEdge.node;
            return {
              id: variant.id,
              title: variant.title,
              availableForSale: variant.availableForSale,
              quantityAvailable: variant.quantityAvailable,
              sku: variant.sku,
              price: parseFloat(variant.price.amount),
              compareAtPrice: variant.compareAtPrice ? parseFloat(variant.compareAtPrice.amount) : null,
              options: variant.selectedOptions.map(option => ({
                name: option.name,
                value: option.value
              })),
              image: variant.image ? {
                url: variant.image.url,
                altText: variant.image.altText,
                width: variant.image.width,
                height: variant.image.height
              } : null
            };
          }),
          images: product.images.edges.map(imageEdge => {
            const image = imageEdge.node;
            return {
              url: image.url,
              altText: image.altText,
              width: image.width,
              height: image.height
            };
          }),
          collections: [data.collection.title]
        };
      });
      
      // Add collection title to products
      allProducts = [...allProducts, ...products];
      
      hasNextPage = data.collection.products.pageInfo.hasNextPage;
      cursor = data.collection.products.pageInfo.endCursor;
      
      console.log(`Fetched ${products.length} products for collection ${collectionHandle}, total: ${allProducts.length}`);
      
      if (hasNextPage && allProducts.length < maxProducts) {
        // Add a small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`Error fetching products for collection ${collectionHandle}: ${error.message}`);
      break;
    }
  }
  
  return allProducts;
}

/**
 * Get all products from the shop without using collections
 */
async function getAllProducts(limit = 50) {
  console.log('Fetching products...');
  
  const productsQuery = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          handle
          description
          descriptionHtml
          productType
          tags
          vendor
          createdAt
          publishedAt
          updatedAt
          options {
            id
            name
            values
          }
          variants(first: 250) {
            edges {
              node {
                id
                title
                quantityAvailable
                availableForSale
                requiresShipping
                selectedOptions {
                  name
                  value
                }
                compareAtPrice {
                  amount
                  currencyCode
                }
                price {
                  amount
                  currencyCode
                }
                sku
                image {
                  url
                  altText
                  width
                  height
                }
              }
            }
          }
          images(first: 20) {
            edges {
              node {
                url
                altText
                width
                height
              }
            }
          }
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
            maxVariantPrice {
              amount
              currencyCode
            }
          }
          compareAtPriceRange {
            minVariantPrice {
              amount
              currencyCode
            }
            maxVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  `;
  
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  let maxProducts = limit > 0 ? limit : Infinity;
  
  while (hasNextPage && allProducts.length < maxProducts) {
    const variables = {
      first: Math.min(250, maxProducts - allProducts.length),
      after: cursor
    };
    
    try {
      const data = await executeQuery(productsQuery, variables);
      
      const products = data.products.edges.map(edge => {
        const product = edge.node;
        
        // Transform the data to match our schema
        return {
          id: product.id,
          title: product.title,
          handle: product.handle,
          url: `https://${argv.store}/products/${product.handle}`,
          description: product.description,
          descriptionHtml: product.descriptionHtml,
          productType: product.productType,
          vendor: product.vendor,
          tags: product.tags,
          options: product.options,
          createdAt: product.createdAt,
          publishedAt: product.publishedAt,
          updatedAt: product.updatedAt,
          price: parseFloat(product.priceRange.minVariantPrice.amount),
          compareAtPrice: product.compareAtPriceRange.maxVariantPrice.amount !== '0.0' 
            ? parseFloat(product.compareAtPriceRange.maxVariantPrice.amount)
            : null,
          onSale: product.compareAtPriceRange.maxVariantPrice.amount !== '0.0' &&
                 parseFloat(product.compareAtPriceRange.maxVariantPrice.amount) > parseFloat(product.priceRange.minVariantPrice.amount),
          variants: product.variants.edges.map(variantEdge => {
            const variant = variantEdge.node;
            return {
              id: variant.id,
              title: variant.title,
              availableForSale: variant.availableForSale,
              quantityAvailable: variant.quantityAvailable,
              sku: variant.sku,
              price: parseFloat(variant.price.amount),
              compareAtPrice: variant.compareAtPrice ? parseFloat(variant.compareAtPrice.amount) : null,
              options: variant.selectedOptions.map(option => ({
                name: option.name,
                value: option.value
              })),
              image: variant.image ? {
                url: variant.image.url,
                altText: variant.image.altText,
                width: variant.image.width,
                height: variant.image.height
              } : null
            };
          }),
          images: product.images.edges.map(imageEdge => {
            const image = imageEdge.node;
            return {
              url: image.url,
              altText: image.altText,
              width: image.width,
              height: image.height
            };
          })
        };
      });
      
      allProducts = [...allProducts, ...products];
      
      hasNextPage = data.products.pageInfo.hasNextPage;
      cursor = data.products.pageInfo.endCursor;
      
      console.log(`Fetched ${products.length} products, total: ${allProducts.length}`);
      
      if (hasNextPage && allProducts.length < maxProducts) {
        // Add a small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`Error fetching products: ${error.message}`);
      break;
    }
  }
  
  return allProducts;
}

/**
 * Main function to crawl Shopify products using the Storefront API
 */
async function crawlShopifyProductsAPI() {
  try {
    console.log(`\n=== STARTING SHOPIFY API CRAWLER ===`);
    console.log(`Target store: ${argv.store}`);
    
    // Initialize result data structure
    const result = {
      store: `https://${argv.store}`,
      crawledAt: new Date().toISOString(),
      collections: [],
      products: [],
      totalProducts: 0
    };
    
    // Map to keep track of products we've already crawled (to avoid duplicates)
    const crawledProducts = new Map();
    
    // Step 1: Decide whether to crawl by collections or all products
    if (argv.collections) {
      console.log(`\n=== STEP 1: CRAWLING COLLECTIONS ===`);
      
      // Get all collections
      const collections = await getCollections();
      result.collections = collections.map(c => ({
        id: c.id,
        handle: c.handle,
        title: c.title,
        description: c.description,
        productsCount: c.productsCount,
        image: c.image,
        url: `https://${argv.store}/collections/${c.handle}`
      }));
      
      // Step 2: For each collection, crawl products
      console.log(`\n=== STEP 2: CRAWLING PRODUCTS BY COLLECTION ===`);
      
      for (const [index, collection] of collections.entries()) {
        console.log(`\nCollection ${index + 1}/${collections.length}: "${collection.title}" (${collection.handle})`);
        
        // Get products for this collection
        const collectionProducts = await getProductsByCollection(collection.handle, argv.limit);
        
        // Filter out duplicates
        const newProducts = collectionProducts.filter(product => !crawledProducts.has(product.id));
        
        // Add products to result and mark them as crawled
        for (const product of newProducts) {
          crawledProducts.set(product.id, true);
          result.products.push(product);
        }
        
        // Update product count for this collection
        const collectionIndex = result.collections.findIndex(c => c.id === collection.id);
        if (collectionIndex !== -1) {
          result.collections[collectionIndex].crawledProducts = collectionProducts.length;
        }
        
        console.log(`Added ${newProducts.length} new products from collection "${collection.title}"`);
        
        // Save progress after each collection
        result.totalProducts = result.products.length;
        await saveProgress(result, argv.output);
      }
    } else {
      console.log(`\n=== STEP 1: CRAWLING ALL PRODUCTS ===`);
      
      // Get all products without using collections
      const products = await getAllProducts(argv.limit);
      
      result.products = products;
      result.totalProducts = products.length;
      
      // Save progress
      await saveProgress(result, argv.output);
    }
    
    console.log(`\n=== CRAWLING COMPLETED ===`);
    console.log(`Total products: ${result.products.length}`);
    
    // Final save
    result.completedAt = new Date().toISOString();
    await saveProgress(result, argv.output);
    
  } catch (error) {
    console.error('Crawling failed:', error);
  }
}

// Run the crawler
crawlShopifyProductsAPI().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 