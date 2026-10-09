// apps/api/src/services/__tests__/product.service.test.ts

import {
  CreateProductSchema,
  UpdateProductSchema,
  SearchProductSchema,
  StockAdjustmentSchema,
} from '../product.service.js'

const mockCtx = {
  tenantId:         '00000000-0000-0000-0000-000000000001',
  branchId:         '00000000-0000-0000-0000-000000000002',
  userId:           '00000000-0000-0000-0000-000000000003',
  role:             'owner',
  branchDomainType: 'retail',
}

// =============================================================================
// CreateProductSchema validation
// =============================================================================
describe('CreateProductSchema', () => {

  const base = { name: 'Amul Butter 100g', salePrice: 55 }

  test('minimal valid product', () => {
    expect(CreateProductSchema.safeParse(base).success).toBe(true)
  })

  test('defaults are applied correctly', () => {
    const result = CreateProductSchema.parse(base)
    expect(result.itemType).toBe('product')
    expect(result.gstRate).toBe(0)
    expect(result.gstExempt).toBe(false)
    expect(result.unit).toBe('pcs')
    expect(result.trackStock).toBe(true)
    expect(result.lowStockQty).toBe(0)
    expect(result.domainAttrs).toEqual({})
  })

  test('rejects empty name', () => {
    expect(CreateProductSchema.safeParse({ ...base, name: '' }).success).toBe(false)
  })

  test('rejects name over 300 chars', () => {
    expect(CreateProductSchema.safeParse({ ...base, name: 'x'.repeat(301) }).success).toBe(false)
  })

  test('rejects invalid GST rate', () => {
    expect(CreateProductSchema.safeParse({ ...base, gstRate: 15 }).success).toBe(false)
    expect(CreateProductSchema.safeParse({ ...base, gstRate: 3  }).success).toBe(false)
  })

  test('accepts all valid GST rates', () => {
    for (const rate of [0, 5, 12, 18, 28]) {
      expect(CreateProductSchema.safeParse({ ...base, gstRate: rate }).success).toBe(true)
    }
  })

  test('accepts all valid item types', () => {
    for (const itemType of ['product', 'service', 'combo']) {
      expect(CreateProductSchema.safeParse({ ...base, itemType }).success).toBe(true)
    }
  })

  test('rejects negative salePrice', () => {
    expect(CreateProductSchema.safeParse({ ...base, salePrice: -1 }).success).toBe(false)
  })

  test('rejects negative openingStock', () => {
    expect(CreateProductSchema.safeParse({ ...base, openingStock: -10 }).success).toBe(false)
  })

  test('accepts valid opening stock', () => {
    const result = CreateProductSchema.safeParse({
      ...base,
      openingStock: 100,
      openingRate:  48,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.openingStock).toBe(100)
      expect(result.data.openingRate).toBe(48)
    }
  })

  test('full product with all fields', () => {
    const result = CreateProductSchema.safeParse({
      itemType:      'product',
      name:          'Aashirvaad Atta 5kg',
      nameLocal:     'आशीर्वाद आटा',
      sku:           'ASH-ATTA-5KG',
      barcode:       '8901030003045',
      hsnSacCode:    '11010000',
      gstRate:       0,
      gstExempt:     false,
      unit:          'pcs',
      purchasePrice: 185,
      salePrice:     210,
      mrp:           220,
      trackStock:    true,
      lowStockQty:   5,
      domainAttrs:   { brand: 'Aashirvaad', pack_size: '5kg' },
      openingStock:  50,
      openingRate:   185,
    })
    expect(result.success).toBe(true)
  })
})

// =============================================================================
// UpdateProductSchema validation
// =============================================================================
describe('UpdateProductSchema', () => {

  test('allows partial updates — only name', () => {
    expect(UpdateProductSchema.safeParse({ name: 'New Name' }).success).toBe(true)
  })

  test('allows updating GST rate alone', () => {
    expect(UpdateProductSchema.safeParse({ gstRate: 18 }).success).toBe(true)
  })

  test('empty object is valid (no-op update)', () => {
    expect(UpdateProductSchema.safeParse({}).success).toBe(true)
  })

  test('openingStock not allowed in update (schema should not have it)', () => {
    const result = UpdateProductSchema.safeParse({ openingStock: 100 })
    // openingStock is omitted from UpdateProductSchema — extra keys ignored or rejected
    // depending on whether Zod strips unknowns
    if (result.success) {
      expect((result.data as Record<string, unknown>)['openingStock']).toBeUndefined()
    }
  })

  test('rejects invalid gstRate in update', () => {
    expect(UpdateProductSchema.safeParse({ gstRate: 7 }).success).toBe(false)
  })
})

// =============================================================================
// SearchProductSchema validation
// =============================================================================
describe('SearchProductSchema', () => {

  test('empty query is valid (returns all)', () => {
    const result = SearchProductSchema.parse({})
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
  })

  test('barcode search', () => {
    const result = SearchProductSchema.parse({ barcode: '8901030003045' })
    expect(result.barcode).toBe('8901030003045')
  })

  test('text search', () => {
    const result = SearchProductSchema.parse({ q: 'amul butter' })
    expect(result.q).toBe('amul butter')
  })

  test('pagination coerces strings to numbers', () => {
    const result = SearchProductSchema.parse({ page: '2', limit: '50' })
    expect(result.page).toBe(2)
    expect(result.limit).toBe(50)
  })

  test('limit capped at 100', () => {
    const result = SearchProductSchema.parse({ limit: '500' })
    expect(result.limit).toBe(100)
  })

  test('lowStock flag coerced from string', () => {
    const result = SearchProductSchema.parse({ lowStock: 'true' })
    expect(result.lowStock).toBe(true)
  })

  test('category filter accepts UUID', () => {
    const result = SearchProductSchema.parse({
      category: '00000000-0000-0000-0000-000000000001',
    })
    expect(result.category).toBe('00000000-0000-0000-0000-000000000001')
  })

  test('rejects invalid category UUID', () => {
    expect(SearchProductSchema.safeParse({ category: 'not-a-uuid' }).success).toBe(false)
  })
})

// =============================================================================
// StockAdjustmentSchema validation
// =============================================================================
describe('StockAdjustmentSchema', () => {
  const base = {
    productId: '00000000-0000-0000-0000-000000000001',
    qty:       10,
    reason:    'Physical count correction',
  }

  test('positive adjustment (stock increase)', () => {
    expect(StockAdjustmentSchema.safeParse(base).success).toBe(true)
  })

  test('negative adjustment (stock decrease)', () => {
    expect(StockAdjustmentSchema.safeParse({ ...base, qty: -5 }).success).toBe(true)
  })

  test('zero quantity is allowed (no-op adjustment)', () => {
    expect(StockAdjustmentSchema.safeParse({ ...base, qty: 0 }).success).toBe(true)
  })

  test('requires a reason', () => {
    const result = StockAdjustmentSchema.safeParse({ ...base, reason: '' })
    expect(result.success).toBe(false)
  })

  test('accepts optional batch ID', () => {
    const result = StockAdjustmentSchema.safeParse({
      ...base,
      batchId: '00000000-0000-0000-0000-000000000099',
    })
    expect(result.success).toBe(true)
  })

  test('rejects invalid batchId (not UUID)', () => {
    expect(StockAdjustmentSchema.safeParse({ ...base, batchId: 'batch-001' }).success).toBe(false)
  })
})

// =============================================================================
// Domain attr validation per domain type
// =============================================================================
describe('Domain attrs validation via DOMAIN_REGISTRY', () => {
  const { validateProductAttrs } = require('@billing/domain-registry')

  describe('retail domain', () => {
    test('valid retail attrs', () => {
      expect(() => validateProductAttrs('retail', {
        brand:       'Amul',
        pack_size:   '100g',
        reorder_qty: 20,
      })).not.toThrow()
    })

    test('rejects extra keys (strict mode)', () => {
      expect(() => validateProductAttrs('retail', {
        unknown_field: 'value',
      })).toThrow()
    })

    test('empty object is valid (all optional)', () => {
      expect(() => validateProductAttrs('retail', {})).not.toThrow()
    })
  })

  describe('pharmacy domain', () => {
    test('valid OTC drug attrs', () => {
      expect(() => validateProductAttrs('pharmacy', {
        schedule:  'OTC',
        drug_type: 'tablet',
      })).not.toThrow()
    })

    test('valid Schedule H drug', () => {
      expect(() => validateProductAttrs('pharmacy', {
        schedule:    'H',
        requires_rx: true,
        drug_type:   'injection',
        manufacturer:'Cipla',
      })).not.toThrow()
    })

    test('rejects invalid schedule', () => {
      expect(() => validateProductAttrs('pharmacy', { schedule: 'Z' })).toThrow()
    })

    test('rejects invalid drug type', () => {
      expect(() => validateProductAttrs('pharmacy', { drug_type: 'powder' })).toThrow()
    })
  })

  describe('restaurant domain', () => {
    test('valid veg menu item', () => {
      expect(() => validateProductAttrs('restaurant', {
        is_veg:        true,
        prep_time_min: 15,
        station:       'hot_kitchen',
      })).not.toThrow()
    })

    test('rejects prep_time_min over 180', () => {
      expect(() => validateProductAttrs('restaurant', {
        prep_time_min: 200,
      })).toThrow()
    })

    test('rejects invalid allergen', () => {
      expect(() => validateProductAttrs('restaurant', {
        allergens: ['shellfish', 'peanuts'],  // 'peanuts' not in enum
      })).toThrow()
    })

    test('rejects invalid station', () => {
      expect(() => validateProductAttrs('restaurant', {
        station: 'rooftop',
      })).toThrow()
    })
  })

  describe('salon domain', () => {
    test('valid service attrs', () => {
      expect(() => validateProductAttrs('salon', {
        duration_min:       45,
        gender:             'female',
        commission_type:    'pct',
        commission_value:   15,
        requires_booking:   true,
      })).not.toThrow()
    })

    test('rejects duration over 480 min (8 hours)', () => {
      expect(() => validateProductAttrs('salon', { duration_min: 500 })).toThrow()
    })
  })

  describe('sweet shop domain', () => {
    test('valid weight-sold item', () => {
      expect(() => validateProductAttrs('sweet', {
        sold_by:         'weight',
        rate_per_unit:   'kg',
        shelf_life_hrs:  24,
        box_eligible:    true,
      })).not.toThrow()
    })

    test('rejects invalid sold_by value', () => {
      expect(() => validateProductAttrs('sweet', { sold_by: 'litre' })).toThrow()
    })
  })

  describe('wholesale domain', () => {
    test('valid product with price tiers', () => {
      expect(() => validateProductAttrs('wholesale', {
        case_qty:      24,
        min_order_qty: 6,
        lead_time_days:3,
        price_tiers: [
          { min_qty: 50,  rate: 48 },
          { min_qty: 100, rate: 44 },
        ],
      })).not.toThrow()
    })

    test('rejects negative case_qty', () => {
      expect(() => validateProductAttrs('wholesale', { case_qty: -1 })).toThrow()
    })
  })
})

// =============================================================================
// HSN suggestion response parsing
// Tests the shape of what we expect Claude to return
// =============================================================================
describe('HSN suggestion response format', () => {
  const validSuggestion = {
    hsnCode:     '04051000',
    description: 'Butter',
    gstRate:     12 as const,
    confidence:  0.95,
  }

  test('valid suggestion shape', () => {
    const schema = require('zod').z.object({
      hsnCode:     require('zod').z.string().min(4).max(20),
      description: require('zod').z.string(),
      gstRate:     require('zod').z.number().refine((v: number) => [0,5,12,18,28].includes(v)),
      confidence:  require('zod').z.number().min(0).max(1),
    })
    expect(schema.safeParse(validSuggestion).success).toBe(true)
  })

  test('gstRate must be a valid Indian GST rate', () => {
    const invalidSuggestion = { ...validSuggestion, gstRate: 15 }
    const schema = require('zod').z.object({
      gstRate: require('zod').z.number().refine((v: number) => [0,5,12,18,28].includes(v)),
    })
    expect(schema.safeParse(invalidSuggestion).success).toBe(false)
  })
})
