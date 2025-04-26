import fs from 'fs-extra';
import { JSDOM } from 'jsdom';
import path from 'path';

/**
 * Processes a shopify product data file containing script tags with product JSON
 * and extracts the product data with variant images
 */
async function processShopifyProductJson(inputFile, outputFile) {
  try {
    console.log(`Processing ${inputFile}...`);
    
    // Read the input file
    const fileContent = await fs.readFile(inputFile, 'utf-8');
    
    // Parse the HTML content
    const dom = new JSDOM(fileContent);
    const document = dom.window.document;
    
    // Look for the product JSON script tag
    const scriptElement = document.querySelector('script#ProductJson-product-template, script[type="application/json"][id*="Product"]');
    
    if (!scriptElement) {
      console.error('No product JSON script tag found');
      return;
    }
    
    try {
      // Parse the JSON content from the script tag
      const productJson = JSON.parse(scriptElement.textContent);
      
      console.log(`Found product: ${productJson.title}`);
      console.log(`Variants: ${productJson.variants.length}`);
      console.log(`Images: ${productJson.images.length}`);
      
      // Process variants to ensure they have image data
      const processedJson = processVariantImages(productJson);
      
      // Write the processed JSON to the output file
      await fs.writeJson(outputFile, processedJson, { spaces: 2 });
      
      console.log(`Processed data saved to ${outputFile}`);
    } catch (error) {
      console.error(`Error parsing product JSON: ${error.message}`);
    }
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
  }
}

/**
 * Process product data to ensure all variants have images
 */
function processVariantImages(productJson) {
  // Create a mapping of variant IDs to images
  const variantImageMap = new Map();
  
  // First pass: map variant IDs to featured images
  if (productJson.images && Array.isArray(productJson.images)) {
    productJson.images.forEach(img => {
      if (img.variant_ids && Array.isArray(img.variant_ids)) {
        img.variant_ids.forEach(variantId => {
          variantImageMap.set(variantId.toString(), img.src);
        });
      }
    });
  }
  
  // Second pass: ensure all variants have images
  if (productJson.variants && Array.isArray(productJson.variants)) {
    productJson.variants.forEach(variant => {
      // Use the variant's featured_image if it exists
      if (variant.featured_image && variant.featured_image.src) {
        variant.image = variant.featured_image.src;
      } 
      // Use the image from the variant ID mapping
      else if (variantImageMap.has(variant.id.toString())) {
        variant.image = variantImageMap.get(variant.id.toString());
      } 
      // Fallback to the first product image
      else if (productJson.images && productJson.images.length > 0) {
        variant.image = productJson.images[0].src;
      }
    });
  }
  
  return productJson;
}

// Run the script if called directly
const inputFile = process.argv[2] || 'shopify_products_image.json';
const outputFile = process.argv[3] || 'processed_data/shopify_products_clean.json';

// Ensure the output directory exists
fs.ensureDirSync(path.dirname(outputFile));

processShopifyProductJson(inputFile, outputFile).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 