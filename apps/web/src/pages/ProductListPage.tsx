// src/pages/ProductListPage.tsx
import { useState, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { useProducts, useCreateProduct, useUpdateProduct, useSuggestHSN, useConfirmHSN } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { Plus, Search, Package, Sparkles, Check, X, Camera, Pencil, Upload, Printer, LayoutGrid, List } from 'lucide-react'
import { productApi, categoryApi, brandApi } from '@/lib/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth.store'
import { getEntityConfig } from '@/lib/entityConfig'
import { DomainAttrsForm } from '@/components/product/DomainAttrsForm'

// ── Barcode label printing ────────────────────────────────────────────────────
// Generates a Code-128B barcode as SVG bars and opens a print window.
// No external library required.

const CODE128B_CHARS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'
const CODE128B_PATTERNS: Record<number, string> = {
  0:'11011001100',1:'11001101100',2:'11001100110',3:'10010011000',4:'10010001100',
  5:'10001001100',6:'10011001000',7:'10011000100',8:'10001100100',9:'11001001000',
  10:'11001000100',11:'11000100100',12:'10110011100',13:'10011011100',14:'10011001110',
  15:'10111001100',16:'10011101100',17:'10011100110',18:'11001110010',19:'11001011100',
  20:'11001001110',21:'11011100100',22:'11001110100',23:'11101101110',24:'11101001100',
  25:'11100101100',26:'11100100110',27:'11101100100',28:'11100110100',29:'11100110010',
  30:'11011011000',31:'11011000110',32:'11000110110',33:'10100011000',34:'10001011000',
  35:'10001000110',36:'10110001000',37:'10001101000',38:'10001100010',39:'11010001000',
  40:'11000101000',41:'11000100010',42:'10110111000',43:'10110001110',44:'10001101110',
  45:'10111011000',46:'10111000110',47:'10001110110',48:'11101110110',49:'11010001110',
  50:'11000101110',51:'11011101000',52:'11011100010',53:'11011101110',54:'11101011000',
  55:'11101000110',56:'11100010110',57:'11101101000',58:'11101100010',59:'11100011010',
  60:'11101111010',61:'11001000010',62:'11110001010',63:'10100110000',64:'10100001100',
  65:'10010110000',66:'10010000110',67:'10000101100',68:'10000100110',69:'10110010000',
  70:'10110000100',71:'10011010000',72:'10011000010',73:'10000110100',74:'10000110010',
  75:'11000010010',76:'11001010000',77:'11110111010',78:'11000010100',79:'10001111010',
  80:'10100111100',81:'10010111100',82:'10010011110',83:'10111100100',84:'10011110100',
  85:'10011110010',86:'11110100100',87:'11110010100',88:'11110010010',89:'11011011110',
  90:'11011110110',91:'11110110110',92:'10101111000',93:'10100011110',94:'10001011110',
  95:'10111101000',96:'10111100010',97:'11110101000',98:'11110100010',99:'10111011110',
  100:'10111101110',101:'11101011110',102:'11110101110',
  // Start B = 104, Stop = 106
  104:'11010010000', 106:'11000111010',
}

function encodeCode128B(text: string): string {
  // Start-B
  let checksum = 104
  let bars = CODE128B_PATTERNS[104]!
  for (let i = 0; i < text.length; i++) {
    const tableKey = CODE128B_CHARS.indexOf(text[i]!)
    if (tableKey < 0) continue
    checksum += tableKey * (i + 1)
    bars += CODE128B_PATTERNS[tableKey] ?? '10110011100'
  }
  const check = checksum % 103
  bars += CODE128B_PATTERNS[check] ?? '10110011100'
  bars += CODE128B_PATTERNS[106]! // Stop
  bars += '11' // termination
  return bars
}

function printProductLabel(product: { name: string; sku?: string | null; barcode?: string | null; salePrice: number }) {
  const code = product.barcode || product.sku || product.name.slice(0, 20)
  const bars  = encodeCode128B(code)

  const BAR_W = 2
  const BAR_H = 60
  const svgW  = bars.length * BAR_W
  let svgBars = ''
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] === '1') {
      svgBars += `<rect x="${i * BAR_W}" y="0" width="${BAR_W}" height="${BAR_H}" fill="black"/>`
    }
  }
  const barcodeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${BAR_H}" viewBox="0 0 ${svgW} ${BAR_H}">${svgBars}</svg>`

  const html = `<!DOCTYPE html><html><head><title>Label</title><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px;width:200px}
    .name{font-size:11px;font-weight:600;text-align:center;margin-bottom:4px;max-width:190px;word-break:break-word}
    .price{font-size:14px;font-weight:700;margin-bottom:4px}
    .code{font-size:9px;color:#555;margin-top:2px;font-family:monospace}
    @media print{body{width:200px}@page{size:50mm 30mm;margin:0}}
  </style></head><body>
    <div class="name">${product.name}</div>
    <div class="price">₹${Number(product.salePrice).toFixed(2)}</div>
    ${barcodeSvg}
    <div class="code">${code}</div>
  </body></html>`

  const win = window.open('', '_blank', 'width=300,height=250')
  if (!win) return
  win.document.write(html)
  win.document.close()
  win.onload = () => { win.print(); win.close() }
}

// Domains that support brands
const BRANDS_DOMAINS = new Set([
  'retail','pharmacy','electronics','wholesale','enterprise',
  'optical','jewellery','automobile','textile','hardware','agri','petrol_pump','repair','transport',
])

function ProductImage({ id, name, size = 'sm' }: { id: string; name: string; size?: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  const cls = size === 'lg' ? 'w-full h-full object-cover' : 'w-full h-full object-cover'
  if (failed) return <Package className={size === 'lg' ? 'w-8 h-8 text-gray-400' : 'w-4 h-4 text-gray-400'} />
  return (
    <img
      src={productApi.imageUrl(id)}
      alt={name}
      className={cls}
      onError={() => setFailed(true)}
    />
  )
}

// Domain-aware unit options — first entry is the default
const DOMAIN_UNITS: Record<string, string[]> = {
  restaurant:     ['pcs', 'plate', 'portion', 'glass', 'bottle', 'kg', 'g', 'l', 'ml'],
  hotel:          ['night', 'pcs', 'plate', 'portion', 'kg', 'l'],
  pharmacy:       ['strip', 'tablet', 'bottle', 'ml', 'g', 'capsule', 'sachet', 'unit'],
  clinic:         ['session', 'consultation', 'procedure', 'test', 'pcs'],
  diagnostic_lab: ['test', 'profile', 'report', 'pcs'],
  salon:          ['session', 'service', 'hour', 'pcs', 'ml', 'g'],
  gym:            ['month', 'session', 'class', 'day', 'pcs'],
  coaching:       ['month', 'session', 'batch', 'course', 'pcs'],
  photography:    ['event', 'hour', 'album', 'print', 'pcs'],
  catering:       ['pax', 'platter', 'kg', 'portion', 'pcs'],
  tiffin:         ['day', 'month', 'meal', 'pcs'],
  laundry:        ['piece', 'kg', 'set', 'pcs'],
  printing:       ['sheet', 'copy', 'set', 'roll', 'pcs'],
  petrol_pump:    ['litre', 'kg', 'pcs'],
  automobile:     ['pcs', 'job', 'litre', 'kg', 'set'],
  repair:         ['pcs', 'job', 'hour', 'set'],
  pest_control:   ['visit', 'sqft', 'job', 'pcs'],
  jewellery:      ['g', 'gm', 'pcs', 'set', 'carat'],
  textile:        ['meter', 'yard', 'pcs', 'set', 'kg'],
  agri:           ['kg', 'bag', 'litre', 'box', 'pcs', 'quintal'],
  sweet:          ['kg', 'g', 'box', 'pcs', 'dozen'],
  optical:        ['pcs', 'pair', 'set', 'lens'],
  wholesale:      ['pcs', 'box', 'carton', 'dozen', 'kg', 'litre', 'meter'],
  enterprise:     ['pcs', 'box', 'carton', 'kg', 'litre', 'set'],
}
const DEFAULT_UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'box', 'dozen', 'meter', 'set']

function getUnitsForDomain(domainType: string): string[] {
  return DOMAIN_UNITS[domainType] ?? DEFAULT_UNITS
}

type ViewMode = 'list' | 'grid'

function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('product-view-mode') as ViewMode | null) ?? 'list'
  })
  function set(m: ViewMode) {
    localStorage.setItem('product-view-mode', m)
    setMode(m)
  }
  return [mode, set]
}

export function ProductListPage() {
  const [search, setSearch]           = useState('')
  const [activeCat, setActiveCat]     = useState<string | null>(null)
  const [activeBrand, setActiveBrand] = useState<string>('')
  const [consumableFilter, setConsumableFilter] = useState<'all' | 'sale' | 'consumable'>('all')
  const [showAddModal, setShowAddModal]       = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editProduct, setEditProduct]         = useState<any | null>(null)
  const [viewMode, setViewMode]               = useViewMode()

  const branch = useAuthStore((s) => s.branch)
  const domainType: string = branch?.domainType ?? ''
  const entityCfg = getEntityConfig(domainType)
  const catalogPlural   = entityCfg.catalogPlural
  const catalogSingular = entityCfg.catalogSingular
  const hasBrands = BRANDS_DOMAINS.has(domainType)

  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: categoryApi.list })
  const { data: brands }     = useQuery({ queryKey: ['brands'], queryFn: brandApi.list, enabled: hasBrands })

  const { data, isLoading } = useProducts({
    q:           search || undefined,
    categoryId:  activeCat ?? undefined,
    brandId:     activeBrand || undefined,
    isConsumable: consumableFilter === 'all' ? undefined : consumableFilter === 'consumable',
    limit:       50,
  })

  return (
    <div>
      <PageHeader
        title={catalogPlural}
        subtitle={data?.meta ? `${data.meta.total} ${catalogPlural.toLowerCase()}` : undefined}
        action={
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowImportModal(true)} className="btn-ghost">
              <Upload className="w-4 h-4" /> Import
            </button>
            <button type="button" onClick={() => setShowAddModal(true)} className="btn-primary">
              <Plus className="w-4 h-4" /> Add {catalogSingular}
            </button>
          </div>
        }
      />

      <div className="p-8">
        {/* Search + brand filter + view toggle row */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              placeholder={`Search ${catalogPlural.toLowerCase()}...`}
              aria-label={`Search ${catalogPlural.toLowerCase()}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9"
            />
          </div>
          {hasBrands && brands && brands.length > 0 && (
            <select
              value={activeBrand}
              onChange={(e) => setActiveBrand(e.target.value)}
              className="input w-44"
              aria-label="Filter by brand"
            >
              <option value="">All brands</option>
              {brands.map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          {/* View mode toggle */}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-label="List view"
              title="List view"
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'list'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-label="Grid view (with images)"
              title="Grid view (with images)"
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'grid'
                  ? 'bg-white shadow-sm text-gray-900'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Consumable / For Sale filter */}
        <div className="flex gap-1 mb-4">
          {([['all', 'All'], ['sale', 'For Sale'], ['consumable', 'Consumables']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setConsumableFilter(key)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                consumableFilter === key
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Category filter tabs */}
        {categories && categories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide">
            <button
              type="button"
              onClick={() => setActiveCat(null)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                activeCat === null
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            {categories.map((cat: any) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCat(cat.id)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1 ${
                  activeCat === cat.id
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat.icon && <span>{cat.icon}</span>}
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {isLoading && (
          <div className="text-gray-400 text-center py-12">Loading...</div>
        )}
        {!isLoading && data?.data?.length === 0 && (
          <div className="text-gray-400 text-center py-12">No products found</div>
        )}

        {viewMode === 'grid' ? (
          <div className="grid grid-cols-4 gap-4">
            {data?.data?.map((product: any) => (
              <ProductCard key={product.id} product={product} onEdit={() => setEditProduct(product)} />
            ))}
          </div>
        ) : (
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Product</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 hidden sm:table-cell">Category</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Price</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 hidden md:table-cell">Stock</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 hidden lg:table-cell">HSN / GST</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 w-20">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data?.data?.map((product: any) => (
                  <ProductRow key={product.id} product={product} onEdit={() => setEditProduct(product)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showImportModal && (
        <BulkImportModal onClose={() => setShowImportModal(false)} domainType={domainType} />
      )}

      {showAddModal && (
        <AddProductModal
          onClose={() => setShowAddModal(false)}
          categories={categories ?? []}
          brands={hasBrands ? (brands ?? []) : []}
          hasBrands={hasBrands}
          domainType={domainType}
        />
      )}

      {editProduct && (
        <EditProductModal
          product={editProduct}
          onClose={() => setEditProduct(null)}
          categories={categories ?? []}
          brands={hasBrands ? (brands ?? []) : []}
          hasBrands={hasBrands}
          domainType={domainType}
        />
      )}
    </div>
  )
}

// ── Product Card with inline HSN suggest ─────────────────────────────────────
function ProductCard({ product, onEdit }: { product: any; onEdit: () => void }) {
  const [hsnSuggestion, setHsnSuggestion] = useState<any>(null)
  const [imgKey, setImgKey]   = useState(0)
  const fileRef               = useRef<HTMLInputElement>(null)
  const queryClient           = useQueryClient()
  const suggestHSN  = useSuggestHSN()
  const confirmHSN  = useConfirmHSN()

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1]!)
        reader.readAsDataURL(file)
      })
      return productApi.uploadImage(product.id, base64, file.type)
    },
    onSuccess: () => {
      setImgKey((k) => k + 1)
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })

  async function handleSuggest() {
    const result = await suggestHSN.mutateAsync(product.id)
    if (result?.suggestions?.[0]) setHsnSuggestion(result.suggestions[0])
  }

  return (
    <div className="card p-4">
      <div className="relative w-full aspect-square rounded-lg bg-gray-100 flex items-center justify-center mb-3 overflow-hidden group">
        <ProductImage id={product.id} name={product.name} key={imgKey} size="lg" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Change image"
        >
          <Camera className="w-5 h-5 text-white" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          aria-label="Upload product image"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage.mutate(f) }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <div className="font-medium text-gray-900 text-sm truncate">{product.name}</div>
        {product.isConsumable && (
          <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">consumable</span>
        )}
      </div>
      {product.category && (
        <div className="text-xs text-gray-400 truncate">{product.category.name}</div>
      )}

      {/* HSN row */}
      {product.hsnSacCode ? (
        <div className="text-xs text-gray-400 mt-0.5">HSN {product.hsnSacCode} · GST {product.gstRate}%</div>
      ) : (
        <div className="mt-1">
          {!hsnSuggestion ? (
            <button
              type="button"
              onClick={handleSuggest}
              disabled={suggestHSN.isPending}
              className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700"
            >
              <Sparkles className="w-3 h-3" />
              {suggestHSN.isPending ? 'Thinking...' : 'Suggest HSN'}
            </button>
          ) : (
            <div className="bg-primary-50 rounded-md p-2 text-xs">
              <p className="font-medium text-primary-800">HSN {hsnSuggestion.hsnCode} · {hsnSuggestion.gstRate}% GST</p>
              <p className="text-primary-600 truncate">{hsnSuggestion.description}</p>
              <div className="flex gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={() => {
                    confirmHSN.mutate({ id: product.id, hsnCode: hsnSuggestion.hsnCode, gstRate: hsnSuggestion.gstRate })
                    setHsnSuggestion(null)
                  }}
                  className="flex items-center gap-0.5 text-green-700 font-medium"
                >
                  <Check className="w-3 h-3" /> Accept
                </button>
                <button
                  type="button"
                  onClick={() => setHsnSuggestion(null)}
                  className="flex items-center gap-0.5 text-gray-500"
                >
                  <X className="w-3 h-3" /> Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-3">
        <span className="text-sm font-semibold text-gray-900">₹{Number(product.salePrice)}</span>
        <div className="flex items-center gap-2">
          {product.trackStock && (
            <span className={`text-xs ${product.stockOnHand <= Number(product.lowStockQty) ? 'text-red-500' : 'text-gray-400'}`}>
              {product.stockOnHand} {product.unit}{product.packSize ? ` · ${product.packSize}` : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => printProductLabel(product)}
            className="p-1 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
            title="Print label"
            aria-label="Print label"
          >
            <Printer className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="p-1 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
            title="Edit product"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Product Row (list view) ───────────────────────────────────────────────────
function ProductRow({ product, onEdit }: { product: any; onEdit: () => void }) {
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900 truncate max-w-[200px]">{product.name}</div>
        {product.isConsumable && (
          <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
            consumable
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-400 text-xs hidden sm:table-cell">
        {product.category?.name ?? '—'}
      </td>
      <td className="px-4 py-3 text-right font-medium text-gray-900 whitespace-nowrap">
        ₹{Number(product.salePrice).toLocaleString('en-IN')}
      </td>
      <td className="px-4 py-3 text-right text-xs hidden md:table-cell">
        {product.trackStock ? (
          <span className={Number(product.stockOnHand) <= Number(product.lowStockQty) ? 'text-red-500' : 'text-gray-400'}>
            {product.stockOnHand} {product.unit}{product.packSize ? ` · ${product.packSize}` : ''}
          </span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-gray-400 hidden lg:table-cell">
        {product.hsnSacCode ? `HSN ${product.hsnSacCode} · ${product.gstRate}%` : '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => printProductLabel(product)}
            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
            title="Print label"
            aria-label="Print label"
          >
            <Printer className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
            title="Edit product"
            aria-label="Edit product"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── Bulk Import Modal ─────────────────────────────────────────────────────────
// Accepts CSV paste or file upload. Columns: name, salePrice, purchasePrice,
// gstRate, unit, barcode, openingStock, openingRate
// Sends to POST /api/products/bulk-import and shows a per-row result table.
const DOMAIN_IMPORT_SAMPLES: Record<string, { hint: string; sample: string }> = {
  pharmacy: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, openingRate, hsnSacCode, genericName, manufacturer, form, strengthDosage, stripQty, drugSchedule, storageCondition',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,openingRate,hsnSacCode,genericName,manufacturer,form,strengthDosage,stripQty,drugSchedule,storageCondition
Paracetamol 500mg,12,8,12,strip,8901234567890,100,8,3004,Paracetamol,Cipla,tablet,500mg,10,OTC,Cool & dry
Dolo 650,22,15,12,strip,8901234567891,50,15,3004,Paracetamol,Micro Labs,tablet,650mg,15,OTC,Cool & dry
Amoxicillin 500mg,85,60,12,strip,,30,60,3004,Amoxicillin,Sun Pharma,capsule,500mg,10,H,Refrigerate`,
  },
  restaurant: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, category, mealType, cuisineType, preparationTimeMin, allergens',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,category,mealType,cuisineType,preparationTimeMin,allergens
Paneer Butter Masala,220,80,5,plate,,0,996331,North Indian,lunch,Indian,15,dairy
Veg Biryani,180,60,5,plate,,0,996331,Biryani,lunch,Indian,20,
Fresh Lime Soda,60,10,5,glass,,0,996331,Beverages,all-day,Indian,2,
Basmati Rice,120,40,5,kg,,10,1006,Ingredients,,,0,`,
  },
  salon: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, packSize',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,packSize
Haircut (Ladies),300,0,18,session,,0,997212,service,Hair Services,45 min
Hair Colour (Global),800,400,18,session,,0,997212,service,Hair Services,90 min
Facial Basic,500,150,18,session,,0,999721,service,Skin Services,60 min
Wella Shampoo 500ml,650,350,18,bottle,8901234100001,5,33051,product,Hair Products,500ml`,
  },
  gym: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, packSize, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,packSize,mrp
Monthly Membership,1500,0,18,month,,0,999311,service,Memberships,30 days,1500
Quarterly Membership,4000,0,18,quarter,,0,999311,service,Memberships,90 days,4500
Personal Training Session,500,0,18,session,,0,999311,service,Personal Training,1 hour,500
Whey Protein 1kg,2500,1800,18,bottle,8901234200001,10,21069,product,Supplements,1kg,2800`,
  },
  hotel: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, packSize',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,packSize
Standard Room,2500,0,12,night,,0,996311,service,Room Charges,1 night
Deluxe Room,4000,0,12,night,,0,996311,service,Room Charges,1 night
Breakfast Buffet,350,120,5,plate,,0,996331,service,Food & Beverages,
Airport Transfer,800,400,18,trip,,0,996421,service,Transport,
Mineral Water 1L,80,40,18,bottle,8901234300001,50,2201,product,Minibar,1L`,
  },
  wholesale: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, openingRate, hsnSacCode, packSize, mrp, lowStockQty',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,openingRate,hsnSacCode,packSize,mrp,lowStockQty
Cotton Fabric (White),85,65,5,meter,,500,65,5208,,95,50
Polyester Blend,60,45,12,meter,,300,45,5407,,70,30
Button Set,25,15,12,set,8901234400001,200,15,9606,12pcs,30,20`,
  },
  textile: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, category, packSize, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,category,packSize,mrp
Kurta (M),599,350,5,pcs,8901111222333,50,62044,Kurta,M,699
Saree (Cotton),1200,700,5,pcs,8901111222334,20,63015,Saree,5.5m,1400
Dupatta,299,150,5,pcs,,30,63014,Dupatta,2.5m,350`,
  },
  jewellery: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, category, weightGrams, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,category,weightGrams,mrp
Gold Ring 22K,18500,17000,3,pcs,JW001,,7113,Gold Jewellery,4.2,18500
Silver Anklet,1200,900,3,pcs,JW002,10,7113,Silver Jewellery,12.5,1400
Diamond Pendant,45000,38000,3,pcs,JW003,2,7113,Diamond Jewellery,2.1,48000`,
  },
  automobile: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, openingRate, hsnSacCode, itemType, category, modelNumber, compatibleModels, warrantyMonths',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,openingRate,hsnSacCode,itemType,category,modelNumber,compatibleModels,warrantyMonths
Engine Oil 5W-30 1L,450,320,18,bottle,8901234500001,20,320,2710,product,Engine Oil & Fluids,,,6
Air Filter (i20),350,220,28,pcs,8901234500002,5,220,8421,product,Filters,AF-101,i20/Grand i10,12
Oil Change Service,500,0,18,job,,0,0,998714,service,Service Packages,,,
Tyre Rotation,300,0,18,job,,0,0,998714,service,Service Packages,,,`,
  },
  event_management: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, packSize, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,packSize,mrp
Wedding Decoration Package,85000,45000,18,job,,0,998554,service,Decoration,Full day,95000
DJ Setup (Full Night),25000,15000,18,job,,0,998554,service,DJ & Music,8 hours,28000
Catering (Per Plate),650,350,5,pax,,0,996334,service,Catering,1 person,700
Flower Arrangement,8000,4000,18,job,,0,998554,service,Decoration,Per stage,9000
Photography (Full Day),20000,8000,18,job,,0,998382,service,Photography,8 hours,22000`,
  },
  photography: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, packSize, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,packSize,mrp
Wedding Photography,25000,8000,18,job,,0,998382,service,Wedding,Full day,28000
Portrait Session,3000,500,18,session,,0,998382,service,Portrait,1 hour,3500
Photo Album (Premium),5000,2500,18,pcs,,5,4911,product,Albums,40 pages,5500
Photo Print 12x18,150,60,18,pcs,,100,4911,product,Prints,12x18 inch,180`,
  },
  clinic: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category
General Consultation,500,0,0,visit,,0,999312,service,Consultation
Follow-up Consultation,300,0,0,visit,,0,999312,service,Consultation
Dressing (Minor),200,50,0,job,,0,999312,service,Procedures
Surgical Gloves (Box),250,180,12,box,8901234600001,20,3006,product,Consumables`,
  },
  diagnostic_lab: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, testCode, sampleType, turnaroundHours, requiresFasting',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,testCode,sampleType,turnaroundHours,requiresFasting
Complete Blood Count,350,0,0,test,,0,999312,service,Haematology,CBC,blood,4,false
Lipid Profile,600,0,0,test,,0,999312,service,Biochemistry,LP,blood,6,true
HbA1c,700,0,0,test,,0,999312,service,Biochemistry,HBA1C,blood,8,false
Urine Routine,200,0,0,test,,0,999312,service,Urine,URE,urine,2,false`,
  },
  pest_control: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, openingRate, hsnSacCode, itemType, category, activeIngredient, targetPest, applicationMethod',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,openingRate,hsnSacCode,itemType,category,activeIngredient,targetPest,applicationMethod
General Pest Control (1BHK),1500,400,18,job,,0,0,998594,service,Services,,,spraying
Cockroach Treatment,2000,500,18,job,,0,0,998594,service,Services,,,gel bait
Cypermethrin 25EC 1L,850,600,18,bottle,8901234700001,10,600,3808,product,Chemicals,Cypermethrin,crawling insects,dilute & spray`,
  },
  laundry: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category
Shirt Wash & Iron,50,0,18,pcs,,0,997014,service,Wash & Iron
Saree (Dry Clean),200,0,18,pcs,,0,997014,service,Dry Cleaning
Bedsheet (King),120,0,18,pcs,,0,997014,service,Wash & Iron
Detergent Liquid 1L,180,120,18,bottle,8901234800001,20,34022,product,Consumables`,
  },
  optical: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, category, packSize, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,category,packSize,mrp
Single Vision Lens (pair),800,400,12,pair,,20,9001,Lenses,standard,950
Progressive Lens (pair),3500,1800,12,pair,,10,9001,Lenses,progressive,4000
Full Frame (Metal),1200,700,12,pcs,OPT001,15,9003,Frames,medium,1400
Contact Lens (monthly),600,350,12,pair,OPT002,30,9001,Contact Lenses,monthly,700`,
  },
  tiffin: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, mealType',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,mealType
Veg Tiffin (Lunch),80,35,5,tiffin,,0,996331,service,Tiffin Plans,lunch
Non-Veg Tiffin (Lunch),100,50,5,tiffin,,0,996331,service,Tiffin Plans,lunch
Monthly Veg Plan,2000,800,5,month,,0,996331,service,Monthly Plans,lunch
Extra Roti (2pcs),10,3,5,pcs,,0,996331,service,Add-ons,`,
  },
  repair: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, hsnSacCode, itemType, category, warrantyMonths',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,hsnSacCode,itemType,category,warrantyMonths
Screen Replacement (iPhone 13),3500,2000,18,job,,0,998719,service,Screen Repair,3
Battery Replacement,800,400,18,job,,0,998719,service,Battery,6
Charging Port Repair,500,150,18,job,,0,998719,service,Hardware,3
Tempered Glass,150,60,18,pcs,8901234900001,50,7007,product,Accessories,0`,
  },
  _default: {
    hint: 'name, salePrice, purchasePrice, gstRate, unit, barcode, openingStock, openingRate, hsnSacCode, category, mrp',
    sample: `name,salePrice,purchasePrice,gstRate,unit,barcode,openingStock,openingRate,hsnSacCode,category,mrp
Product A,500,350,18,pcs,8901234567001,100,350,,General,550
Product B,1200,800,12,pcs,8901234567002,50,800,,General,1300
Service C,2000,0,18,job,,0,0,,Services,2000`,
  },
}

function BulkImportModal({ onClose, domainType = '' }: { onClose: () => void; domainType?: string }) {
  const domainImport = DOMAIN_IMPORT_SAMPLES[domainType] ?? DOMAIN_IMPORT_SAMPLES['_default']!
  const queryClient = useQueryClient()
  const fileRef     = useRef<HTMLInputElement>(null)
  const [csv, setCsv]       = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<any | null>(null)

  const COLS = ['name','salePrice','purchasePrice','gstRate','unit','barcode','openingStock','openingRate'] as const

  // Map a raw object (from XLSX) or a CSV column array to a product row
  function normaliseRow(raw: Record<string, unknown>): Record<string, unknown> | null {
    // Support both header-mapped objects (Excel) and positional CSV
    const name = String(raw.name ?? raw.Name ?? raw['Product Name'] ?? raw['PRODUCT NAME'] ?? '').trim()
    if (!name) return null
    const row: Record<string, unknown> = { name }
    const num = (k: string, ...aliases: string[]) => {
      for (const key of [k, ...aliases]) {
        const v = raw[key] ?? raw[key.toLowerCase()] ?? raw[key.toUpperCase()]
        if (v !== undefined && v !== '') return Number(v)
      }
      return undefined
    }
    const str = (k: string, ...aliases: string[]) => {
      for (const key of [k, ...aliases]) {
        const v = raw[key] ?? raw[key.toLowerCase()]
        if (v !== undefined && String(v).trim()) return String(v).trim()
      }
      return undefined
    }
    const sp = num('salePrice','sale_price','Sale Price','SALE PRICE','MRP','mrp')
    const pp = num('purchasePrice','purchase_price','Purchase Price','PURCHASE PRICE','Cost','cost')
    const gr = num('gstRate','gst_rate','GST Rate','GST%','gst','GST')
    const os = num('openingStock','opening_stock','Opening Stock','Stock','stock','QTY','qty','Qty')
    const or_ = num('openingRate','opening_rate','Opening Rate','Rate','rate')
    const unit = str('unit','Unit','UNIT','UOM','uom')
    const barcode = str('barcode','Barcode','BARCODE','EAN','ean','UPC','upc')
    if (sp !== undefined) row.salePrice     = sp
    if (pp !== undefined) row.purchasePrice = pp
    if (gr !== undefined) row.gstRate       = gr
    if (os !== undefined) row.openingStock  = os
    if (or_ !== undefined) row.openingRate  = or_
    if (unit)    row.unit    = unit
    if (barcode) row.barcode = barcode
    return row
  }

  const parseCsv = useCallback((text: string) => {
    const lines = text.trim().split('\n').filter(Boolean)
    if (lines.length === 0) return []
    const firstLine = lines[0]!.toLowerCase()
    const hasHeader = COLS.some((h) => firstLine.includes(h.toLowerCase()))
    const headers = hasHeader
      ? lines[0]!.split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
      : COLS as unknown as string[]
    const dataLines = hasHeader ? lines.slice(1) : lines
    return dataLines.flatMap((line) => {
      const vals = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      const raw: Record<string, unknown> = {}
      headers.forEach((h, i) => { raw[h] = vals[i] ?? '' })
      const row = normaliseRow(raw)
      return row ? [row] : []
    })
  }, [])

  function parseExcel(buffer: ArrayBuffer) {
    const wb = XLSX.read(buffer, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]!]!
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
    return json.flatMap((raw) => { const r = normaliseRow(raw); return r ? [r] : [] })
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const isExcel = /\.(xlsx|xls|ods)$/i.test(file.name)
    if (isExcel) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const rows = parseExcel(ev.target!.result as ArrayBuffer)
        // Convert back to CSV text so the textarea shows the data
        const header = COLS.join(',')
        const body   = rows.map((r) =>
          COLS.map((c) => r[c] ?? '').join(',')
        ).join('\n')
        setCsv(`${header}\n${body}`)
      }
      reader.readAsArrayBuffer(file)
    } else {
      const reader = new FileReader()
      reader.onload = (ev) => setCsv(ev.target!.result as string)
      reader.readAsText(file)
    }
    // reset input so same file can be re-selected
    e.target.value = ''
  }

  const rows = parseCsv(csv)

  const importMutation = useMutation({
    mutationFn: (r: unknown[]) => productApi.bulkImport(r),
    onSuccess: (data) => {
      setResult(data)
      queryClient.invalidateQueries({ queryKey: ['products'] })
    },
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Bulk import products</h3>
          <button type="button" onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {!result ? (
          <>
            <p className="text-sm text-gray-500 mb-3">
              Upload a supplier bill in Excel or CSV, or paste CSV directly. One product per row.
            </p>

            {/* Column guide */}
            <div className="bg-gray-50 rounded-lg p-3 mb-3 text-xs text-gray-500 font-mono overflow-x-auto whitespace-nowrap">
              {domainImport.hint}
            </div>

            <div className="flex items-center gap-2 mb-2">
              <button
                type="button"
                onClick={() => setCsv(domainImport.sample)}
                className="text-xs text-primary-600 hover:underline"
              >
                Load sample
              </button>
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-500">Download:</span>
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([domainImport.sample], { type: 'text/csv' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `sample-import-${domainType || 'products'}.csv`
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                className="text-xs text-primary-600 hover:underline"
              >
                CSV
              </button>
              <span className="text-gray-300">|</span>
              <button
                type="button"
                onClick={() => {
                  const lines = domainImport.sample.trim().split('\n')
                  const [headerLine, ...dataLines] = lines
                  const headers = (headerLine ?? '').split(',').map(h => h.trim())
                  const rows = dataLines.map(line => {
                    const vals = line.split(',')
                    return Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? '']))
                  })
                  const ws = XLSX.utils.json_to_sheet(rows, { header: headers })
                  // Auto-fit column widths based on max content length
                  ws['!cols'] = headers.map(h => {
                    const maxLen = Math.max(h.length, ...rows.map(r => String((r as any)[h] ?? '').length))
                    return { wch: Math.min(maxLen + 4, 40) }
                  })
                  const wb = XLSX.utils.book_new()
                  XLSX.utils.book_append_sheet(wb, ws, 'Products')
                  XLSX.writeFile(wb, `sample-import-${domainType || 'products'}.xlsx`)
                }}
                className="text-xs text-primary-600 hover:underline"
              >
                XLSX
              </button>
              <span className="text-gray-300">·</span>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="text-xs text-primary-600 hover:underline"
              >
                Upload .xlsx / .csv
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls,.ods,text/csv"
                className="hidden"
                aria-label="Upload Excel or CSV file"
                onChange={handleFile}
              />
              {fileName && <span className="text-xs text-gray-400 truncate max-w-[160px]">{fileName}</span>}
            </div>

            <textarea
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setFileName(null) }}
              placeholder="Paste CSV here, or upload a file above…"
              className="input w-full h-48 font-mono text-xs resize-none"
            />

            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-gray-400">
                {rows.length > 0 ? `${rows.length} rows detected` : 'No rows yet'}
              </span>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
                <button
                  type="button"
                  onClick={() => importMutation.mutate(rows)}
                  disabled={importMutation.isPending || rows.length === 0}
                  className="btn-primary"
                >
                  {importMutation.isPending ? 'Importing…' : `Import ${rows.length || ''} products`}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Result summary */}
            <div className="flex gap-4 mb-4">
              <div className="flex-1 bg-green-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-green-700">{result.created}</div>
                <div className="text-xs text-green-600">Created</div>
              </div>
              <div className="flex-1 bg-yellow-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-yellow-700">{result.skipped}</div>
                <div className="text-xs text-yellow-600">Skipped</div>
              </div>
              <div className="flex-1 bg-red-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-red-700">{result.failed}</div>
                <div className="text-xs text-red-600">Failed</div>
              </div>
            </div>

            {/* Per-row table */}
            <div className="border border-gray-100 rounded-lg overflow-hidden text-sm">
              <table className="w-full">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {result.rows.map((row: any) => (
                    <tr key={row.index}>
                      <td className="px-3 py-2 text-gray-400 text-xs">{row.index + 1}</td>
                      <td className="px-3 py-2 text-gray-800">{row.name ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                          row.status === 'created' ? 'bg-green-100 text-green-700' :
                          row.status === 'skipped' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {row.status === 'created' && <Check className="w-3 h-3" />}
                          {row.status === 'skipped' && '—'}
                          {row.status === 'failed'  && <X className="w-3 h-3" />}
                          {row.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-400">{row.reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end mt-4">
              <button type="button" onClick={onClose} className="btn-primary">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Add Product Modal ─────────────────────────────────────────────────────────
function AddProductModal({
  onClose,
  categories,
  brands,
  hasBrands,
  domainType,
}: {
  onClose: () => void
  categories: any[]
  brands: any[]
  hasBrands: boolean
  domainType: string
}) {
  const createProduct = useCreateProduct()
  const queryClient   = useQueryClient()
  const fileRef       = useRef<HTMLInputElement>(null)
  const unitOptions   = getUnitsForDomain(domainType)
  const [form, setForm] = useState({
    name: '', salePrice: '', purchasePrice: '', gstRate: '0',
    unit: 'pcs', packSize: '', barcode: '', openingStock: '',
    categoryId: '', brandId: '', isConsumable: false,
  })
  const [domainAttrs, setDomainAttrs]   = useState<Record<string, unknown>>({})
  const [imageFile, setImageFile]       = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    const reader = new FileReader()
    reader.onload = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  async function handleSubmit() {
    if (!form.name || !form.salePrice) return
    const product = await createProduct.mutateAsync({
      name:          form.name,
      salePrice:     Number(form.salePrice),
      purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
      gstRate:       Number(form.gstRate),
      unit:          form.unit,
      packSize:      form.packSize || undefined,
      barcode:       form.barcode || undefined,
      openingStock:  form.openingStock ? Number(form.openingStock) : undefined,
      categoryId:    form.categoryId || undefined,
      brandId:       form.brandId || undefined,
      isConsumable:  form.isConsumable,
      domainAttrs:   Object.keys(domainAttrs).length ? domainAttrs : undefined,
    })
    if (imageFile && product?.id) {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1]!)
        reader.readAsDataURL(imageFile)
      })
      await productApi.uploadImage(product.id, base64, imageFile.type)
      queryClient.invalidateQueries({ queryKey: ['products'] })
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Add product</h3>

        <div className="space-y-3">
          {/* Image picker */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 hover:border-primary-400 hover:text-primary-500 transition-colors overflow-hidden flex-shrink-0"
            >
              {imagePreview ? (
                <img src={imagePreview} alt="preview" className="w-full h-full object-cover" />
              ) : (
                <>
                  <Camera className="w-5 h-5 mb-1" />
                  <span className="text-xs">Add photo</span>
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              aria-label="Product image"
              className="hidden"
              onChange={handleImagePick}
            />
            <div className="text-xs text-gray-400">
              Upload a product photo.<br />JPG, PNG, WebP supported.
            </div>
          </div>

          <div>
            <label className="label" htmlFor="prod-name">Product name</label>
            <input
              id="prod-name"
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input"
              placeholder="e.g. Amul Butter 100g"
            />
          </div>

          {/* Category + Brand */}
          <div className={`grid gap-3 ${hasBrands ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {categories.length > 0 && (
              <div>
                <label className="label" htmlFor="prod-category">Category</label>
                <select
                  id="prod-category"
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                  className="input"
                >
                  <option value="">— None —</option>
                  {categories.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            {hasBrands && brands.length > 0 && (
              <div>
                <label className="label" htmlFor="prod-brand">Brand</label>
                <select
                  id="prod-brand"
                  value={form.brandId}
                  onChange={(e) => setForm({ ...form, brandId: e.target.value })}
                  className="input"
                >
                  <option value="">— None —</option>
                  {brands.map((b: any) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="prod-sale">Sale price</label>
              <input
                id="prod-sale"
                type="number"
                placeholder="0"
                value={form.salePrice}
                onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="prod-purchase">Purchase price</label>
              <input
                id="prod-purchase"
                type="number"
                placeholder="0"
                value={form.purchasePrice}
                onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
                className="input"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="prod-gst">GST rate</label>
              <select
                id="prod-gst"
                value={form.gstRate}
                onChange={(e) => setForm({ ...form, gstRate: e.target.value })}
                className="input"
              >
                {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="prod-unit">Stock Unit</label>
              <select
                id="prod-unit"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                className="input"
              >
                {['pcs', 'bottle', 'box', 'dozen', 'kg', 'g', 'litre', 'ml', 'meter', 'yard', 'set', 'pair', 'strip', 'tablet', 'bag', 'roll', 'sheet'].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-0.5">How you count stock (pcs, bottles…)</p>
            </div>
            <div>
              <label className="label" htmlFor="prod-packsize">Pack Size (optional)</label>
              <input
                id="prod-packsize"
                placeholder="e.g. 50ml, 1kg, 500g"
                value={form.packSize}
                onChange={(e) => setForm({ ...form, packSize: e.target.value })}
                className="input"
              />
              <p className="text-xs text-gray-400 mt-0.5">Size/volume of each unit</p>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="prod-barcode">Barcode (optional)</label>
            <input
              id="prod-barcode"
              placeholder="Scan or type barcode"
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              className="input"
            />
          </div>

          <div>
            <label className="label" htmlFor="prod-stock">Opening stock (optional)</label>
            <input
              id="prod-stock"
              type="number"
              placeholder="0"
              value={form.openingStock}
              onChange={(e) => setForm({ ...form, openingStock: e.target.value })}
              className="input"
            />
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isConsumable}
              onChange={(e) => setForm({ ...form, isConsumable: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 text-primary-600"
            />
            <div>
              <div className="text-sm font-medium text-gray-700">Consumable (internal use)</div>
              <div className="text-xs text-gray-400">Used during service delivery, not directly sold</div>
            </div>
          </label>

          <DomainAttrsForm
            domainType={domainType}
            values={domainAttrs}
            onChange={setDomainAttrs}
          />
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={createProduct.isPending}
            className="btn-primary flex-1 justify-center"
          >
            {createProduct.isPending ? 'Saving...' : 'Add Product'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Edit Product Modal ────────────────────────────────────────────────────────
function EditProductModal({
  product,
  onClose,
  categories,
  brands,
  hasBrands,
  domainType,
}: {
  product: any
  onClose: () => void
  categories: any[]
  brands: any[]
  hasBrands: boolean
  domainType: string
}) {
  const updateProduct = useUpdateProduct()
  const queryClient   = useQueryClient()
  const fileRef       = useRef<HTMLInputElement>(null)
  const unitOptions   = getUnitsForDomain(domainType)
  const [imgKey, setImgKey]             = useState(0)
  const [imageFile, setImageFile]       = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [domainAttrs, setDomainAttrs]   = useState<Record<string, unknown>>(
    (product.domainAttrs && typeof product.domainAttrs === 'object') ? product.domainAttrs : {}
  )
  const [priceMeta, setPriceMeta] = useState({
    wholesalePrice: String((product.meta as any)?.wholesalePrice ?? ''),
    specialPrice:   String((product.meta as any)?.specialPrice ?? ''),
  })
  const [form, setForm] = useState({
    name:          product.name ?? '',
    salePrice:     String(product.salePrice ?? ''),
    purchasePrice: String(product.purchasePrice ?? ''),
    mrp:           String(product.mrp ?? ''),
    gstRate:       String(product.gstRate ?? '0'),
    unit:          product.unit ?? 'pcs',
    packSize:      product.packSize ?? '',
    barcode:       product.barcode ?? '',
    categoryId:    product.categoryId ?? '',
    brandId:       product.brandId ?? '',
    isConsumable:  product.isConsumable ?? false,
  })

  function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    const reader = new FileReader()
    reader.onload = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  async function handleSubmit() {
    if (!form.name || !form.salePrice) return
    const metaUpdate: Record<string, unknown> = { ...(product.meta ?? {}) }
    if (priceMeta.wholesalePrice) metaUpdate.wholesalePrice = Number(priceMeta.wholesalePrice)
    else delete metaUpdate.wholesalePrice
    if (priceMeta.specialPrice) metaUpdate.specialPrice = Number(priceMeta.specialPrice)
    else delete metaUpdate.specialPrice

    await updateProduct.mutateAsync({
      id: product.id,
      data: {
        name:          form.name,
        salePrice:     Number(form.salePrice),
        purchasePrice: form.purchasePrice ? Number(form.purchasePrice) : undefined,
        mrp:           form.mrp ? Number(form.mrp) : undefined,
        gstRate:       Number(form.gstRate),
        unit:          form.unit,
        packSize:      form.packSize || undefined,
        barcode:       form.barcode || undefined,
        categoryId:    form.categoryId || undefined,
        brandId:       form.brandId || undefined,
        isConsumable:  form.isConsumable,
        domainAttrs:   Object.keys(domainAttrs).length ? domainAttrs : undefined,
        meta:          Object.keys(metaUpdate).length ? metaUpdate : undefined,
      },
    })
    if (imageFile) {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1]!)
        reader.readAsDataURL(imageFile)
      })
      await productApi.uploadImage(product.id, base64, imageFile.type)
      setImgKey((k) => k + 1)
      queryClient.invalidateQueries({ queryKey: ['products'] })
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Edit product</h3>

        <div className="space-y-3">
          {/* Image */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 hover:border-primary-400 hover:text-primary-500 transition-colors overflow-hidden flex-shrink-0"
            >
              {imagePreview ? (
                <img src={imagePreview} alt="preview" className="w-full h-full object-cover" />
              ) : (
                <ProductImage id={product.id} name={product.name} key={imgKey} size="lg" />
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              aria-label="Product image"
              className="hidden"
              onChange={handleImagePick}
            />
            <div className="text-xs text-gray-400">Click to change photo.<br />JPG, PNG, WebP supported.</div>
          </div>

          <div>
            <label className="label" htmlFor="edit-name">Product name</label>
            <input
              id="edit-name"
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input"
            />
          </div>

          {/* Category + Brand */}
          <div className={`grid gap-3 ${hasBrands ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {categories.length > 0 && (
              <div>
                <label className="label" htmlFor="edit-category">Category</label>
                <select
                  id="edit-category"
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                  className="input"
                >
                  <option value="">— None —</option>
                  {categories.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            {hasBrands && brands.length > 0 && (
              <div>
                <label className="label" htmlFor="edit-brand">Brand</label>
                <select
                  id="edit-brand"
                  value={form.brandId}
                  onChange={(e) => setForm({ ...form, brandId: e.target.value })}
                  className="input"
                >
                  <option value="">— None —</option>
                  {brands.map((b: any) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="edit-sale">Sale price</label>
              <input
                id="edit-sale"
                type="number"
                value={form.salePrice}
                onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="edit-purchase">Purchase price</label>
              <input
                id="edit-purchase"
                type="number"
                value={form.purchasePrice}
                onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="edit-mrp">MRP</label>
              <input
                id="edit-mrp"
                type="number"
                value={form.mrp}
                onChange={(e) => setForm({ ...form, mrp: e.target.value })}
                className="input"
              />
            </div>
          </div>

          {/* Wholesale / Special prices — only shown when price groups enabled */}
          {localStorage.getItem('pos_price_groups') === 'true' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="edit-wholesale">Wholesale Price</label>
                <input
                  id="edit-wholesale"
                  type="number"
                  min={0}
                  value={priceMeta.wholesalePrice}
                  onChange={(e) => setPriceMeta(p => ({ ...p, wholesalePrice: e.target.value }))}
                  className="input"
                  placeholder="Leave blank to use sale price"
                />
              </div>
              <div>
                <label className="label" htmlFor="edit-special">Special Price</label>
                <input
                  id="edit-special"
                  type="number"
                  min={0}
                  value={priceMeta.specialPrice}
                  onChange={(e) => setPriceMeta(p => ({ ...p, specialPrice: e.target.value }))}
                  className="input"
                  placeholder="Leave blank to use sale price"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="edit-gst">GST rate</label>
              <select
                id="edit-gst"
                value={form.gstRate}
                onChange={(e) => setForm({ ...form, gstRate: e.target.value })}
                className="input"
              >
                {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="edit-unit">Stock Unit</label>
              <select
                id="edit-unit"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                className="input"
              >
                {['pcs', 'bottle', 'box', 'dozen', 'kg', 'g', 'litre', 'ml', 'meter', 'yard', 'set', 'pair', 'strip', 'tablet', 'bag', 'roll', 'sheet'].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-0.5">How you count stock</p>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="edit-packsize">Pack Size (optional)</label>
            <input
              id="edit-packsize"
              placeholder="e.g. 50ml, 1kg, 500g, 200mg"
              value={form.packSize}
              onChange={(e) => setForm({ ...form, packSize: e.target.value })}
              className="input"
            />
            <p className="text-xs text-gray-400 mt-0.5">Size/volume of each unit — shown on product but not used for stock counting</p>
          </div>

          <div>
            <label className="label" htmlFor="edit-barcode">Barcode</label>
            <input
              id="edit-barcode"
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              className="input"
              placeholder="Scan or type barcode"
            />
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isConsumable}
              onChange={(e) => setForm({ ...form, isConsumable: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 text-primary-600"
            />
            <div>
              <div className="text-sm font-medium text-gray-700">Consumable (internal use)</div>
              <div className="text-xs text-gray-400">Used during service delivery, not directly sold</div>
            </div>
          </label>

          <DomainAttrsForm
            domainType={domainType}
            values={domainAttrs}
            onChange={setDomainAttrs}
          />
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={updateProduct.isPending}
            className="btn-primary flex-1 justify-center"
          >
            {updateProduct.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
