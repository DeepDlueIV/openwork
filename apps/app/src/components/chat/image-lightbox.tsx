import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

export type LightboxImage = { src: string; alt: string }

type ImageLightboxProps = {
  images: LightboxImage[]
  index: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onIndexChange?: (index: number) => void
}

/**
 * Full-size image viewer shared by sent, queued, draft and assistant images.
 * With more than one image, the arrow buttons and ←/→ keys step through them.
 */
export function ImageLightbox({ images, index, open, onOpenChange, onIndexChange }: ImageLightboxProps) {
  const image = images[index]
  if (!image) return null
  const stepper = images.length > 1 && onIndexChange ? onIndexChange : null
  const hasPrevious = index > 0
  const hasNext = index < images.length - 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-image-lightbox=""
        data-image-index={index}
        data-image-count={images.length}
        className="max-h-[95vh] w-auto max-w-[95vw] overflow-hidden border-none bg-transparent p-0 shadow-none ring-0 lg:w-max lg:max-w-[95vw]"
        onKeyDown={(event) => {
          if (!stepper) return
          const target = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : -1
          if (target < 0 || target >= images.length) return
          event.preventDefault()
          event.stopPropagation()
          stepper(target)
        }}
      >
        <DialogTitle className="sr-only">{image.alt}</DialogTitle>
        <img src={image.src} alt={image.alt} className="max-h-[92vh] w-auto max-w-full rounded-xl object-contain" />
        {stepper ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="absolute top-1/2 inset-s-3 -translate-y-1/2 rounded-full shadow-sm"
              disabled={!hasPrevious}
              onClick={() => stepper(index - 1)}
              aria-label="Previous image"
              title="Previous image"
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="absolute top-1/2 inset-e-3 -translate-y-1/2 rounded-full shadow-sm"
              disabled={!hasNext}
              onClick={() => stepper(index + 1)}
              aria-label="Next image"
              title="Next image"
            >
              <ChevronRight />
            </Button>
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-xs font-medium tabular-nums text-white">
              {index + 1} / {images.length}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

type GalleryEntry = { image: LightboxImage; node: HTMLElement | null }

type Gallery = {
  add: (entry: GalleryEntry) => () => void
  expand: (entry: GalleryEntry) => void
}

const ImageGalleryContext = React.createContext<Gallery | null>(null)

function byDocumentOrder(a: GalleryEntry, b: GalleryEntry) {
  if (!a.node || !b.node || a.node === b.node) return 0
  return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
}

/** Expanded images inside can step to every other on-screen image in the gallery, in page order. */
export function ImageGallery({ children }: { children: React.ReactNode }) {
  const entries = React.useRef(new Set<GalleryEntry>())
  const [view, setView] = React.useState<{ images: LightboxImage[]; index: number } | null>(null)
  const gallery = React.useMemo<Gallery>(() => ({
    add: (entry) => {
      entries.current.add(entry)
      return () => {
        entries.current.delete(entry)
      }
    },
    expand: (entry) => {
      const shown = [...entries.current].filter((item) => item.node?.isConnected).sort(byDocumentOrder)
      const index = shown.indexOf(entry)
      setView(index < 0
        ? { images: [entry.image], index: 0 }
        : { images: shown.map((item) => item.image), index })
    },
  }), [])

  return (
    <ImageGalleryContext.Provider value={gallery}>
      {children}
      {view ? (
        <ImageLightbox
          images={view.images}
          index={view.index}
          open
          onOpenChange={(open) => {
            if (!open) setView(null)
          }}
          onIndexChange={(index) => setView({ images: view.images, index })}
        />
      ) : null}
    </ImageGalleryContext.Provider>
  )
}

/**
 * Wires a thumbnail to the lightbox: attach `ref` to the thumbnail and call `expand` on click.
 * Inside an ImageGallery the gallery shows the viewer; otherwise render `lightbox` beside the thumbnail.
 */
export function useExpandableImage(src: string, alt: string) {
  const gallery = React.useContext(ImageGalleryContext)
  const [open, setOpen] = React.useState(false)
  const entry = React.useRef<GalleryEntry>({ image: { src, alt }, node: null })

  React.useLayoutEffect(() => {
    entry.current.image = { src, alt }
  }, [src, alt])
  React.useEffect(() => gallery?.add(entry.current), [gallery])

  const ref = React.useCallback((node: HTMLElement | null) => {
    entry.current.node = node
  }, [])
  const expand = React.useCallback(() => {
    if (gallery) gallery.expand(entry.current)
    else setOpen(true)
  }, [gallery])

  const lightbox = gallery ? null : (
    <ImageLightbox images={[{ src, alt }]} index={0} open={open} onOpenChange={setOpen} />
  )
  return { ref, expand, lightbox }
}
