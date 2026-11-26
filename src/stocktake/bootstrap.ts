import { listCurrencies } from '../catalog/prices.ts';
import { listProducts, MAX_PHOTOS_PER_PRODUCT } from '../catalog/products.ts';
import type { Deps } from '../deps.ts';
import { isoDay } from '../lib/text.ts';
import type { ShopContext } from '../shop/context.ts';
import { MAX_COUNT_VIEWS, MAX_PHOTOS_PER_COUNT } from '../vision/reader.ts';
import { ADJUSTMENT_LABELS } from './adjustments.ts';
import { countedSoFar } from './counts.ts';

/** What a request holds besides its photos (the details, the secret, the JSON around them), with room to spare. */
const REQUEST_OVERHEAD = 150_000;

/** Everything the app needs when it opens: the stocktake, the places, the products and what is counted so far. */
export async function bootstrap(deps: Deps, shop: ShopContext, actions: readonly string[]) {
  const [products, counted, currencies] = await Promise.all([
    listProducts(deps.db, shop.id),
    countedSoFar(deps.db, shop),
    listCurrencies(deps.db),
  ]);
  return {
    countDate: shop.stocktake.countDate,
    today: isoDay(new Date(), shop.timeZone),
    locations: shop.locations.map((place) => place.name),
    adjustmentTypes: ADJUSTMENT_LABELS,
    products,
    counted,
    photoSetLimit: MAX_PHOTOS_PER_COUNT,
    // How many views of the same stock one count may hold: the moments kept from a video taken around it.
    countViewLimit: MAX_COUNT_VIEWS,
    // How much photo data one request may carry, in base64 characters, so the app sizes what it sends.
    requestLimit: deps.config.REQUEST_LIMIT_BYTES - REQUEST_OVERHEAD,
    productPhotoLimit: MAX_PHOTOS_PER_PRODUCT,
    currencies,
    // What this server can do, so the app only offers what will work.
    actions,
  };
}
