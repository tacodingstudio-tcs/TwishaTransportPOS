// Client-side image resize + base64 encode
// Keeps images at max 800px wide and ~80% JPEG quality for gallery storage
// Thumbnail: 200px wide at 70% quality

export function resizeToBase64(
  file:       File,
  maxWidth:   number,
  quality:    number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const scale  = Math.min(1, maxWidth / img.width)
        const canvas = document.createElement('canvas')
        canvas.width  = Math.round(img.width  * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = reject
      img.src = e.target!.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export async function prepareGalleryImage(file: File) {
  const [imageData, thumbData] = await Promise.all([
    resizeToBase64(file, 800, 0.80),
    resizeToBase64(file, 200, 0.70),
  ])
  return { imageData, thumbData }
}

export function formatBytes(n: number): string {
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function base64SizeBytes(b64: string): number {
  // Remove data URI prefix and estimate byte size
  const base = b64.split(',')[1] ?? b64
  return Math.round((base.length * 3) / 4)
}
