/**
 * Page attribute extractor framework — public surface + built-in registration.
 *
 * Importing this module registers the SDK's built-in extractors. Hosts register additional
 * vertical/locale packs via `registerPageExtractor` (see registry.ts).
 */
import { registerPageExtractor } from './registry';
import { ecommerceVariantsExtractor } from './ecommerceVariants';
import { realEstateExtractor } from './realEstate';

registerPageExtractor(ecommerceVariantsExtractor);
// Temporary built-in — slated to move to the host app as a registered vertical pack.
registerPageExtractor(realEstateExtractor);

export type {
  PageAttributeExtractor,
  PageExtractionResult,
  PageExtractorContext,
} from './types';
export {
  registerPageExtractor,
  unregisterPageExtractor,
  getRegisteredPageExtractors,
  runPageExtractors,
  type RunPageExtractorsOptions,
  type RunPageExtractorsResult,
} from './registry';
export { ecommerceVariantsExtractor, formatVariantLine } from './ecommerceVariants';
export { realEstateExtractor } from './realEstate';
