// Shapes of the JSON the server returns. Only the fields the client reads are listed.

export interface ArtistCredit {
  id?: string;
  name: string;
  pos?: number | null;
  joinphrase?: string | null;
}

export interface ReleaseGroupRef {
  id?: string;
  title?: string;
  cover_art_url?: string | null;
  cover_art_url_thumbnail_small?: string | null;
}

export interface TrackItem {
  id: string;
  title: string;
  length?: number | null;
  liked?: boolean;
  position?: number | null;
  artists?: ArtistCredit[];
  release_group?: ReleaseGroupRef | null;
}

export interface AlbumItem {
  id: string;
  title: string;
  cover_art_url?: string | null;
  cover_art_url_thumbnail_small?: string | null;
  first_release_date?: number | null;
  musicbrainz_primary_type?: string | null;
}

export interface ArtistItem {
  id: string;
  name: string;
}

export interface AppConfig {
  SHOW_MODAL: boolean;
}
