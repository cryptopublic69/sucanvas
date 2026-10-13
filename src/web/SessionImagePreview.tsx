import { useEffect, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { peekInputImagePreview, requestInputImagePreview } from "./inputImageCache";
import type { InputImagePreview } from "./inputImageCache";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  onDimensions?: (width: number, height: number) => void;
};

export function SessionImagePreview({ src, onDimensions, onLoad, ...props }: Props) {
  const [loaded, setLoaded] = useState<InputImagePreview | undefined>(() => peekInputImagePreview(src));
  const [failedSource, setFailedSource] = useState("");
  const preview = loaded?.src === src ? loaded : peekInputImagePreview(src);
  useEffect(() => {
    let disposed = false;
    const cached = peekInputImagePreview(src);
    if (cached) { setLoaded(cached); return; }
    void requestInputImagePreview(src).then((result) => {
      if (!disposed) setLoaded(result);
    }).catch(() => { if (!disposed) setFailedSource(src); });
    return () => { disposed = true; };
  }, [src]);
  return <img {...props} src={preview?.url ?? (failedSource === src ? src : undefined)} onLoad={(event) => {
    onDimensions?.(preview?.width ?? event.currentTarget.naturalWidth, preview?.height ?? event.currentTarget.naturalHeight);
    onLoad?.(event);
  }} />;
}
