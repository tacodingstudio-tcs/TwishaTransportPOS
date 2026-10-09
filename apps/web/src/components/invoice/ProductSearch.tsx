// src/components/invoice/ProductSearch.tsx
import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { productApi } from '@/lib/api'
import { Search, Package } from 'lucide-react'

function ProductImage({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Package className="w-4 h-4 text-gray-400" />
  return (
    <img
      src={productApi.imageUrl(id)}
      alt={name}
      className="w-8 h-8 object-cover rounded-lg"
      onError={() => setFailed(true)}
    />
  )
}

interface Product {
  id: string
  name: string
  nameLocal?: string | null
  salePrice: number
  gstRate: number
  unit: string
  hsnSacCode: string | null
  stockOnHand: number
  trackStock: boolean
}

interface ProductSearchProps {
  onSelect: (product: Product) => void
}

export function ProductSearch({ onSelect }: ProductSearchProps) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const { data, isFetching } = useQuery({
    queryKey: ['product-search', query],
    queryFn:  () => productApi.list({ q: query, limit: 10 }),
    enabled:  query.trim().length >= 2,
  })

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleSelect(product: Product) {
    onSelect(product)
    setQuery('')
    setIsOpen(false)
  }

  // Barcode scan: if input looks like a barcode (8+ digits), search exact match
  async function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && /^\d{8,}$/.test(query)) {
      e.preventDefault()
      try {
        const product = await productApi.byBarcode(query)
        handleSelect(product)
      } catch {
        // No product with this barcode — let normal search continue
      }
    }
  }

  const results: Product[] = data?.data ?? []

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          autoFocus
          placeholder="Search product name, or scan barcode..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          className="input pl-9 text-base"
        />
      </div>

      {isOpen && query.trim().length >= 2 && (
        <div className="absolute z-20 w-full mt-1 bg-white rounded-lg border border-gray-200 shadow-lg max-h-80 overflow-y-auto">
          {isFetching && (
            <div className="px-4 py-3 text-sm text-gray-400">Searching...</div>
          )}
          {!isFetching && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-gray-400">
              No products found for "{query}"
            </div>
          )}
          {results.map((product) => (
            <button
              type="button"
              key={product.id}
              onClick={() => handleSelect(product)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left border-b border-gray-50 last:border-0"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                  <ProductImage id={product.id} name={product.name} />
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-900">{product.name}</div>
                  <div className="text-xs text-gray-500">
                    {product.trackStock && (
                      <span className={product.stockOnHand <= 0 ? 'text-red-500' : ''}>
                        {product.stockOnHand} {product.unit} in stock
                      </span>
                    )}
                    {product.gstRate > 0 && ` · GST ${product.gstRate}%`}
                  </div>
                </div>
              </div>
              <span className="text-sm font-semibold text-gray-900">
                ₹{product.salePrice}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
