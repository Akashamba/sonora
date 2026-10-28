import { CoverImage } from "./CoverImage";
import { Icon } from "./Icon";

// Playlist artwork. One distinct cover fills the square; two or more fill a 2x2 grid, repeating
// covers when there are fewer than four. A cell shows the note tile only if its image fails to load.
export function PlaylistMosaic({
  covers,
  className = "",
  noteSize = 36,
}: {
  covers: string[];
  className?: string;
  noteSize?: number;
}) {
  const distinct = [...new Set(covers.filter(Boolean))];
  const n = distinct.length;

  if (n === 0) {
    return (
      <div className={`playlist-mosaic empty ${className}`}>
        <Icon name="note" size={noteSize} />
      </div>
    );
  }

  const cells =
    n === 1 ? [distinct[0]!] : [0, 1, 2, 3].map((i) => distinct[i % n]!);
  return (
    <div className={`playlist-mosaic ${n === 1 ? "single" : ""} ${className}`}>
      {cells.map((url, i) => (
        <span className="mosaic-cell" key={`${url}-${i}`}>
          <CoverImage
            src={url}
            className="mosaic-img"
            loading="lazy"
            fallback={
              <span className="mosaic-fallback">
                <Icon name="note" size={noteSize / 2} />
              </span>
            }
          />
        </span>
      ))}
    </div>
  );
}
