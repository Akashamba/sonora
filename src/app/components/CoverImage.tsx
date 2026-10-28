import { useEffect, useState, type ReactNode } from "react";

// Artwork, or the fallback when there is no URL or the image fails to load. Archive.org covers
// often 401 or 500, and a plain <img> would leave a broken-image icon in the grid.
export function CoverImage({
  src,
  fallback,
  className,
  loading,
}: {
  src?: string | null;
  fallback: ReactNode;
  className?: string;
  loading?: "lazy" | "eager";
}) {
  const [broken, setBroken] = useState(false);
  // A new URL gets a fresh attempt.
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt=""
      className={className}
      loading={loading}
      onError={() => setBroken(true)}
    />
  );
}
