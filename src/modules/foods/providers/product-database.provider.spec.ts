import { OpenFoodFactsDatabase, productFromOpenFoodFacts } from './product-database.provider';

describe('Open Food Facts mapping', () => {
  it('reads the per-100-gram values, serving and pack weight', () => {
    const p = productFromOpenFoodFacts(
      '3017624010701',
      {
        product_name: 'Nutella',
        brands: 'Ferrero, Nutella',
        serving_size: '15 g',
        serving_quantity: 15,
        product_quantity: 400,
        product_quantity_unit: 'g',
        nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3, sodium_100g: 0.043, salt_100g: 0.1075 },
      },
      'en',
    );
    expect(p).toEqual({
      barcode: '3017624010701',
      name: 'Nutella',
      brand: 'Ferrero',
      servingG: 15,
      servingText: '15 g',
      packG: 400,
      per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sugarG: 56.3, sodiumMg: 43 },
    });
  });

  it('prefers the name in the user language and falls back to kJ and salt', () => {
    const p = productFromOpenFoodFacts('8941100500118', { product_name: 'Biscuit', product_name_bn: 'বিস্কুট', nutriments: { 'energy-kj_100g': 2092, salt_100g: 1, proteins_100g: '7,5' } }, 'bn');
    expect(p.name).toBe('বিস্কুট');
    expect(p.per100g.kcal).toBe(500);
    expect(p.per100g.sodiumMg).toBe(400);
    expect(p.per100g.proteinG).toBe(7.5);
    expect(p.servingG).toBeNull();
  });

  it('does not take a serving in ounces or pieces as grams', () => {
    expect(productFromOpenFoodFacts('12345678', { serving_quantity: 2, serving_quantity_unit: 'oz', nutriments: {} }, 'en').servingG).toBeNull();
    expect(productFromOpenFoodFacts('12345678', { product_quantity: 1.5, product_quantity_unit: 'l', nutriments: {} }, 'en').packG).toBe(1500);
  });
});

describe('OpenFoodFactsDatabase', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const answer = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    }) as typeof fetch;
    return calls;
  };
  const db = new OpenFoodFactsDatabase('https://off.test/', 'Nouri/test', 1000);

  it('names itself and asks for the product and its nutrients separately', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      // Open Food Facts leaves out the pack fields when nutriments is asked for too.
      const product = url.includes('fields=nutriments') ? { nutriments: { 'energy-kcal_100g': 539 } } : { product_name: 'Nutella', product_quantity: 400, product_quantity_unit: 'g' };
      return Promise.resolve(new Response(JSON.stringify({ status: 1, product }), { status: 200 }));
    }) as typeof fetch;
    const r = await db.lookup('3017624010701', 'en');
    expect(r).toMatchObject({ found: true, product: { name: 'Nutella', packG: 400, per100g: { kcal: 539 } } });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toMatch(/^https:\/\/off\.test\/api\/v2\/product\/3017624010701\.json\?fields=/);
      expect((c.init.headers as Record<string, string>)['User-Agent']).toBe('Nouri/test');
    }
  });

  it('does not report a product whose nutrients could not be fetched', async () => {
    global.fetch = ((url: string) =>
      url.includes('fields=nutriments') ? Promise.reject(new Error('reset')) : Promise.resolve(new Response(JSON.stringify({ status: 1, product: { product_name: 'Nutella' } }), { status: 200 }))) as typeof fetch;
    expect(await db.lookup('3017624010701', 'en')).toEqual({ unavailable: true });
  });

  it('tells an unknown barcode from an outage', async () => {
    answer(404, { status: 0, status_verbose: 'product not found' });
    expect(await db.lookup('00000017', 'en')).toEqual({ found: false });
    answer(503, {});
    expect(await db.lookup('00000017', 'en')).toEqual({ unavailable: true });
    global.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    expect(await db.lookup('00000017', 'en')).toEqual({ unavailable: true });
  });
});
