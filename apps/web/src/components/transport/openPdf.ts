import toast from 'react-hot-toast'
import { transportApi, apiError } from '@/lib/api'

/** Fetches a server-rendered PDF with the user's token and opens it in a new tab (or downloads if popups are blocked). */
export async function openPdf(path: string, filename: string): Promise<void> {
  const t = toast.loading('Preparing PDF…')
  try {
    const blob = await transportApi.pdfBlob(path)
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (!win) {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    toast.dismiss(t)
  } catch (e) {
    toast.error(apiError(e), { id: t })
  }
}
