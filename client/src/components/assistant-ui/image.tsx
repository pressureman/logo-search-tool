"use client";

import {
  memo,
  useState,
  useEffect,
  useRef,
  type PropsWithChildren,
} from "react";
import { createPortal } from "react-dom";
import { cva, type VariantProps } from "class-variance-authority";
import { DownloadIcon, ImageIcon, ImageOffIcon } from "lucide-react";
import type {
  ImageMessagePart,
  ImageMessagePartComponent,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";

const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
};

const dataUriToBlob = (dataUri: string): Blob => {
  const [meta, data] = dataUri.split(",");
  const mime = meta?.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
  if (!/;base64/i.test(meta ?? "")) {
    return new Blob([decodeURIComponent(data ?? "")], { type: mime });
  }
  const bytes = atob(data ?? "");
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

const mimeFromImage = (image: string): string | undefined =>
  image.match(/^data:([^;,]+)/)?.[1];

const downloadImagePart = (
  part: Pick<ImageMessagePart, "image" | "filename">,
): void => {
  if (typeof document === "undefined") return;
  const ext = extensionForMimeType(mimeFromImage(part.image));
  const filename = part.filename ?? `logo.${ext}`;
  const isDataUri = part.image.startsWith("data:");
  const objectUrl = isDataUri
    ? URL.createObjectURL(dataUriToBlob(part.image))
    : null;
  const href = objectUrl ?? part.image;
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
};

const imageVariants = cva("relative overflow-hidden rounded-lg", {
  variants: {
    variant: {
      outline: "border-border border",
      ghost: "",
      muted: "bg-muted/50",
    },
    size: {
      sm: "max-w-64",
      default: "max-w-96",
      lg: "max-w-[512px]",
      full: "w-full",
    },
  },
  defaultVariants: {
    variant: "outline",
    size: "default",
  },
});

export type ImageRootProps = React.ComponentProps<"div"> &
  VariantProps<typeof imageVariants>;

function ImageRoot({
  className,
  variant,
  size,
  children,
  ...props
}: ImageRootProps) {
  return (
    <div
      data-slot="image-root"
      data-variant={variant}
      data-size={size}
      className={cn(
        "group/aui-image",
        imageVariants({ variant, size, className }),
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type ImagePreviewProps = Omit<React.ComponentProps<"img">, "children"> & {
  containerClassName?: string;
};

function ImagePreview({
  className,
  containerClassName,
  onLoad,
  onError,
  alt = "Image content",
  src,
  ...props
}: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);

  const loaded = loadedSrc === src;
  const error = errorSrc === src;

  useEffect(() => {
    if (
      typeof src === "string" &&
      imgRef.current?.complete &&
      imgRef.current.naturalWidth > 0
    ) {
      setLoadedSrc(src);
    }
  }, [src]);

  return (
    <div
      data-slot="image-preview"
      className={cn("relative min-h-32", containerClassName)}
    >
      {!loaded && !error && (
        <div
          data-slot="image-preview-loading"
          className="bg-muted/50 absolute inset-0 flex items-center justify-center"
        >
          <ImageIcon className="text-muted-foreground size-8 animate-pulse" />
        </div>
      )}
      {error ? (
        <div
          data-slot="image-preview-error"
          className="bg-muted/50 flex min-h-32 items-center justify-center p-4"
        >
          <ImageOffIcon className="text-muted-foreground size-8" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={cn(
            "block h-auto w-full object-contain",
            !loaded && "invisible",
            className,
          )}
          onLoad={(e) => {
            if (typeof src === "string") setLoadedSrc(src);
            onLoad?.(e);
          }}
          onError={(e) => {
            if (typeof src === "string") setErrorSrc(src);
            onError?.(e);
          }}
          {...props}
        />
      )}
    </div>
  );
}

function DownloadButton({
  onClick,
  className,
}: {
  onClick: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-slot="image-download"
      aria-label="下载图片"
      className={cn(
        "inline-flex size-8 cursor-pointer items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/80",
        className,
      )}
    >
      <DownloadIcon className="size-4" />
    </button>
  );
}

type ImageZoomProps = PropsWithChildren<{
  part: ImageMessagePart;
  alt?: string;
  onOpenChange?: (open: boolean) => void;
}>;

function ImageZoom({ part, alt = "Image preview", onOpenChange, children }: ImageZoomProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleOpen = () => { setIsOpen(true); onOpenChange?.(true); };
  const handleClose = () => { setIsOpen(false); onOpenChange?.(false); };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    downloadImagePart(part);
  };

  return (
    <>
      <div
        onClick={handleOpen}
        onKeyDown={(e) => e.key === "Enter" && handleOpen()}
        role="button"
        tabIndex={0}
        className="cursor-zoom-in"
        aria-label="点击放大图片"
      >
        {children}
      </div>
      {isMounted &&
        isOpen &&
        createPortal(
          <div
            data-slot="image-zoom-overlay"
            role="button"
            tabIndex={0}
            className="fade-in animate-in fixed inset-0 z-50 flex items-center justify-center bg-black/80 duration-200"
            onClick={handleClose}
            onKeyDown={(e) => e.key === "Enter" && handleClose()}
            aria-label="关闭放大图片"
          >
            <div
              className="max-h-[90vh] max-w-[90vw]"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                data-slot="image-zoom-content"
                src={part.image}
                alt={alt}
                className="fade-in zoom-in-95 animate-in max-h-[90vh] max-w-[90vw] object-contain duration-200"
              />
            </div>
            <DownloadButton
              onClick={handleDownload}
              className="fixed top-10 right-10"
            />
          </div>,
          document.body,
        )}
    </>
  );
}

const ImageImpl: ImageMessagePartComponent = (props) => {
  const part = props as ImageMessagePart;
  const { image, filename } = part;
  const [zoomOpen, setZoomOpen] = useState(false);

  const handleThumbnailDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    downloadImagePart(part);
  };

  return (
    <ImageRoot className="bg-muted my-2 max-h-80 w-auto p-2">
      <ImageZoom part={part} alt={filename || "logo"} onOpenChange={setZoomOpen}>
        <ImagePreview
          src={image}
          alt={filename || "logo"}
          className="max-h-72"
        />
      </ImageZoom>
      {!zoomOpen && (
        <DownloadButton
          onClick={handleThumbnailDownload}
          className="absolute top-3 right-3 opacity-0 transition-opacity group-hover/aui-image:opacity-100"
        />
      )}
    </ImageRoot>
  );
};

const Image = memo(ImageImpl) as unknown as ImageMessagePartComponent & {
  Root: typeof ImageRoot;
  Preview: typeof ImagePreview;
  Zoom: typeof ImageZoom;
};

Image.displayName = "Image";
Image.Root = ImageRoot;
Image.Preview = ImagePreview;
Image.Zoom = ImageZoom;

export { Image, ImageRoot, ImagePreview, ImageZoom };
